/*
 * @Description: 插件自更新 —— 检查、下载 / 上传、检查安装包、交给宿主插件管理器安装
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/update/updater.ts
 *
 * 安装走宿主 pluginManager.installBundle（宿主插件管理页用的同一接口），要点：
 * - 不能先 removeBundle：那会先卸掉本插件的运行时，后端被销毁，后面的安装没人执行。
 * - 直接 add 新的 file: 路径：宿主按「依赖值有变化的包」认定装的是谁，路径每次都带时间戳，保证不同，
 *   否则会报 ambiguous-install 并回滚。
 * - 包已存在时宿主返回 restart-required，不会中途卸载本插件；新代码要重启 DSH 才生效。
 * 安装包放在持久目录（profile 依赖会一直引用这个路径，放系统临时目录被清掉后 pnpm install 会失败）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { compareVersions, isNewer, parseVersion } from './semver.js'
import { downloadAny, fetchLatest, type LatestRelease } from './source.js'
import { inspectTarball, type TarballInfo } from './tarball.js'
import type { ConnectionLog } from '../log/connection-log.js'

/** 宿主 pluginManager 服务里本模块用到的部分。 */
export interface PluginManagerLike {
  installBundle(
    spec: string,
    options?: { requestId?: string; enabled?: boolean }
  ): Promise<{
    application?: string
    error?: { code?: string; diagnostic?: string }
    packageResult?: { output?: string }
    logPath?: string
  }>
  cancelInstall?(requestId: string): Promise<unknown> | unknown
}

export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed'

export interface UpdateJob {
  phase: UpdatePhase
  /** 正在 / 已经安装的版本。 */
  version?: string
  message?: string
  received?: number
  total?: number
}

export interface LatestView {
  version: string
  source: LatestRelease['source']
  notes: string
  publishedAt?: string
  pageUrl: string
  /** 比当前运行的版本新。 */
  newer: boolean
  checkedAt: number
}

export interface UpdateStatus {
  /** 当前进程加载的版本（启动时读取）。 */
  current: string
  /** 磁盘上已装好、等重启生效的版本（与 current 相同则不给）。 */
  pending?: string
  /** 宿主插件管理器是否可用（纯 dsh web 等场景可能没有）。 */
  installer: boolean
  latest?: LatestView
  job: UpdateJob
}

export interface UploadView {
  token: string
  info: TarballInfo
  /** 相对当前版本：newer / same / older。 */
  relation: 'newer' | 'same' | 'older' | 'unknown'
}

export interface UpdaterDeps {
  /** 本插件 package.json 路径（包根目录下）。 */
  packageFile: string
  /** 安装包存放目录。 */
  dir: string
  log: ConnectionLog
  pluginManager(): PluginManagerLike | undefined
  fetchImpl?: typeof fetch
}

/** 缓存查询结果：避免反复点「检查更新」触发 GitHub 频率限制。 */
const CHECK_CACHE_MS = 5 * 60_000
/** 保留最近几个安装包（当前在用 + 回退用），更旧的清理掉。 */
const KEEP_PACKAGES = 3

function readVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export class Updater {
  /** 启动时加载的版本；之后磁盘上的版本变了就说明已安装新版、等重启。 */
  readonly current: string
  private latest: { release: LatestRelease; checkedAt: number } | undefined
  private job: UpdateJob = { phase: 'idle' }
  private uploads = new Map<string, { file: string; info: TarballInfo }>()

  constructor(private readonly deps: UpdaterDeps) {
    this.current = readVersion(deps.packageFile)
  }

  status(): UpdateStatus {
    const onDisk = existsSync(this.deps.packageFile) ? readVersion(this.deps.packageFile) : this.current
    return {
      current: this.current,
      ...(onDisk !== this.current ? { pending: onDisk } : {}),
      installer: this.deps.pluginManager() !== undefined,
      ...(this.latest !== undefined ? { latest: this.latestView(this.latest.release, this.latest.checkedAt) } : {}),
      job: { ...this.job }
    }
  }

  private latestView(release: LatestRelease, checkedAt: number): LatestView {
    return {
      version: release.version,
      source: release.source,
      notes: release.notes,
      ...(release.publishedAt !== undefined ? { publishedAt: release.publishedAt } : {}),
      pageUrl: release.pageUrl,
      newer: isNewer(release.version, this.current),
      checkedAt
    }
  }

  /** 查询最新版本。force=false 时 5 分钟内复用上次结果。 */
  async check(force = false): Promise<UpdateStatus> {
    const fresh = this.latest !== undefined && Date.now() - this.latest.checkedAt < CHECK_CACHE_MS
    if (force || !fresh) {
      const release = await fetchLatest(this.deps.fetchImpl)
      if (parseVersion(release.version) === undefined) throw new Error(`最新版本号无法识别：${release.version}`)
      this.latest = { release, checkedAt: Date.now() }
      this.deps.log.info('', 'update', `检查更新：最新 v${release.version}（来源 ${release.source}），当前 v${this.current}。`)
    }
    return this.status()
  }

  private busy(): boolean {
    return this.job.phase === 'downloading' || this.job.phase === 'verifying' || this.job.phase === 'installing'
  }

  private requireInstaller(): PluginManagerLike {
    const pm = this.deps.pluginManager()
    if (pm === undefined) throw new Error('宿主插件管理器不可用（当前运行环境不支持在线安装插件），请使用离线脚本安装。')
    if (this.busy()) throw new Error('已有更新任务在进行中。')
    return pm
  }

  /** 下载并安装最新版（后台执行，进度经 status() 查询）。 */
  startLatest(): UpdateStatus {
    const pm = this.requireInstaller()
    const release = this.latest?.release
    if (release === undefined) throw new Error('请先检查更新。')
    if (!isNewer(release.version, this.current)) throw new Error(`当前已是最新版本（v${this.current}）。`)
    const version = release.version
    this.job = { phase: 'downloading', version, message: '正在下载安装包…' }
    void this.run(pm, version, async () => {
      await mkdir(this.deps.dir, { recursive: true })
      const file = path.join(this.deps.dir, `yh4922-dsh-workspace-${version}-${stamp()}.tgz`)
      const used = await downloadAny(release.downloads, file, (received, total) => {
        this.job = { ...this.job, received, ...(total !== undefined ? { total } : {}) }
      }, this.deps.fetchImpl)
      this.deps.log.info('', 'update', `已下载 v${version}：${used.url}`)
      this.job = { phase: 'verifying', version, message: '正在检查安装包…' }
      await inspectTarball(file, version)
      return file
    })
    return this.status()
  }

  /**
   * 接收上传的离线包：检查后先不安装，返回包信息给界面确认（可能是降级或同版本）。
   * @param tempFile 上传路由写好的临时文件，本方法负责改名或删除
   */
  async acceptUpload(tempFile: string): Promise<UploadView> {
    try {
      const info = await inspectTarball(tempFile)
      await mkdir(this.deps.dir, { recursive: true })
      const file = path.join(this.deps.dir, `yh4922-dsh-workspace-${info.version}-${stamp()}.tgz`)
      await rename(tempFile, file)
      const token = randomUUID()
      // 只保留最近一次上传：之前没确认安装的包直接删掉。
      for (const old of this.uploads.values()) await rm(old.file, { force: true })
      this.uploads.clear()
      this.uploads.set(token, { file, info })
      const relation = parseVersion(this.current) === undefined
        ? 'unknown'
        : compareVersions(info.version, this.current) > 0 ? 'newer' : compareVersions(info.version, this.current) === 0 ? 'same' : 'older'
      this.deps.log.info('', 'update', `收到离线安装包 v${info.version}（sha256 ${info.sha256.slice(0, 12)}…）。`)
      return { token, info, relation }
    } catch (error) {
      await rm(tempFile, { force: true })
      throw error
    }
  }

  /** 安装已上传的离线包（界面确认后调用）。 */
  startUpload(token: string): UpdateStatus {
    const pm = this.requireInstaller()
    const upload = this.uploads.get(token)
    if (upload === undefined) throw new Error('上传的安装包已失效，请重新上传。')
    this.uploads.delete(token)
    this.job = { phase: 'installing', version: upload.info.version, message: '正在安装…' }
    void this.run(pm, upload.info.version, async () => upload.file)
    return this.status()
  }

  /** 公共流程：准备好安装包 → installBundle → 记录结果 → 清理旧包。 */
  private async run(pm: PluginManagerLike, version: string, prepare: () => Promise<string>): Promise<void> {
    try {
      const file = await prepare()
      this.job = { phase: 'installing', version, message: '正在安装（由 DSH 插件管理器执行 pnpm，可能需要一两分钟）…' }
      // 宿主要求绝对路径；统一正斜杠，与 profile 里现有的 file: 依赖写法一致。
      const spec = `file:${file.replace(/\\/g, '/')}`
      this.deps.log.info('', 'update', `开始安装 v${version}：${spec}`)
      const result = await pm.installBundle(spec, { requestId: `dsh-workspace-update-${randomUUID()}` })
      const application = result.application ?? 'failed'
      if (application === 'failed' || application === 'cancelled') {
        const detail = result.error?.diagnostic ?? result.packageResult?.output ?? ''
        const code = result.error?.code ?? application
        throw new Error(`安装失败（${code}）${detail !== '' ? `：${detail.slice(-800)}` : ''}${result.logPath !== undefined ? `\n日志：${result.logPath}` : ''}`)
      }
      this.job = {
        phase: 'done',
        version,
        message: application === 'applied' ? `已安装 v${version}。` : `已安装 v${version}，重启 DSH 后生效。`
      }
      this.deps.log.info('', 'update', `安装完成 v${version}（${application}）。`)
      await this.prune(file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.job = { phase: 'failed', version, message }
      this.deps.log.error('', 'update', `更新到 v${version} 失败。`, error)
    }
  }

  /** 清理旧安装包：保留最近 KEEP_PACKAGES 个（含刚装的）。 */
  private async prune(keep: string): Promise<void> {
    try {
      const names = (await readdir(this.deps.dir)).filter((n) => n.endsWith('.tgz'))
      const files = await Promise.all(names.map(async (n) => {
        const full = path.join(this.deps.dir, n)
        return { full, mtime: (await stat(full)).mtimeMs }
      }))
      files.sort((a, b) => b.mtime - a.mtime)
      const pendingUploads = new Set([...this.uploads.values()].map((u) => u.file))
      for (const f of files.slice(KEEP_PACKAGES)) {
        if (f.full === keep || pendingUploads.has(f.full)) continue
        await rm(f.full, { force: true })
      }
    } catch {
      /* 清理失败不影响更新结果 */
    }
  }
}
