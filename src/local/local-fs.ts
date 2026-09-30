/*
 * @Description: 本地工作区文件操作 —— 与 RemoteFs 同一套接口，供「文件管理」「Git 仓库」在本地会话里使用
 * @Author: YangHeng
 * @Date: 2026-09-30 16:30:00
 * @FilePath: /dsh-workspace/src/local/local-fs.ts
 *
 * 为了让侧栏前端完全复用远程那套代码（全部按 POSIX 绝对路径处理），本地路径在线上统一写成「本地 POSIX 形式」：
 *   Windows  C:\proj\a.ts → /C:/proj/a.ts        macOS / Linux 原样
 * 浏览器只传会话 id（形如 local:<sessionId> 的 hostId），工作区根目录由宿主按会话 cwd 推导，不信任浏览器传来的根。
 *
 * 安全边界（按用户决定不接 DSH 沙箱，但仍限定在工作区内，防止接口被当成整机文件浏览器）：
 * - 目标必须在会话工作区根目录内（或本仓库自己的其他 git 工作目录内，Git 仓库面板编辑那里的文件时用）
 * - 词法检查之后再对最近的已存在祖先做 realpath，防止符号链接 / Windows 目录联接逃出工作区
 * - Windows 下拒绝 UNC 与设备路径，路径比较不区分大小写
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { buildMatcher, type IgnoreMatcher } from '../sftp/ignore.js'
import {
  RemoteConflictError,
  RemoteExistsError,
  copyNameCandidates,
  normalizeRemotePath,
  utf8RoundTrips,
  validateName,
  type EntryType,
  type ListResult,
  type ReadResult,
  type RemoteEntry,
  type RemoveResult,
  type SearchResult
} from '../sftp/remote-fs.js'
import type { ConnectionLog } from '../log/connection-log.js'

/** 本地会话在线上用的「主机 id」前缀：local:<sessionId>。 */
export const LOCAL_ID_PREFIX = 'local:'

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

export function sessionOfLocalId(id: string): string {
  return id.slice(LOCAL_ID_PREFIX.length)
}

/** 本机原生路径 → 本地 POSIX 形式。 */
export function toLocalPosix(native: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return native
  // 盘符根 C:\ 写成 /C:（不带结尾斜杠），拼子路径时才不会出现 //。
  const s = native.replace(/\\/g, '/').replace(/^([A-Za-z]:)\/$/, '$1')
  return /^[A-Za-z]:/.test(s) ? `/${s}` : s
}

/** 本地 POSIX 形式 → 本机原生路径（规范化）。 */
export function fromLocalPosix(p: string, platform: NodeJS.Platform = process.platform): string {
  const posix = normalizeRemotePath(p)
  if (platform !== 'win32') return posix
  const m = /^\/([A-Za-z]):(\/.*)?$/.exec(posix)
  if (m === null) throw new LocalPathError(`不是本机路径：${p}`)
  return path.win32.resolve(`${m[1]}:${m[2] ?? '/'}`)
}

export class LocalPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalPathError'
  }
}

/** 一个本地会话的工作区范围。 */
export interface LocalScope {
  /** 工作区根目录（原生路径，已 realpath）。 */
  root: string
  /** 允许访问的其他根（本仓库的其他 git 工作目录），按需计算。 */
  extraRoots(): Promise<string[]>
}

export type ScopeResolver = (id: string) => Promise<LocalScope>

const MAX_ENTRIES = 5000
const BINARY_SNIFF_BYTES = 8000
const REMOVE_LIMIT = 200_000
const SEARCH_MAX_DEPTH = 16
const SEARCH_TIMEOUT_MS = 15_000

function key(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** target 是否在 root 内（含 root 本身）。 */
export function isInside(root: string, target: string): boolean {
  const r = key(root.replace(/[\\/]+$/, ''))
  const t = key(target)
  return t === r || t.startsWith(`${r}${path.sep}`)
}

function typeOfStats(s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (s.isSymbolicLink()) return 'symlink'
  if (s.isDirectory()) return 'dir'
  if (s.isFile()) return 'file'
  return 'other'
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** 最近的已存在祖先（含自身）做 realpath，再拼回不存在的部分。 */
async function realpathLoose(p: string): Promise<string> {
  let current = p
  const rest: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return rest.length === 0 ? real : path.join(real, ...rest.reverse())
    } catch (error) {
      if (!isNotFound(error)) throw error
      const parent = path.dirname(current)
      if (parent === current) return p
      rest.push(path.basename(current))
      current = parent
    }
  }
}

export class LocalFs {
  constructor(
    private readonly resolveScope: ScopeResolver,
    private readonly log: ConnectionLog,
    /** 用户自定义的忽略规则（每次调用现取）。 */
    private readonly userIgnore: () => readonly string[] = () => []
  ) {}

  /**
   * 线上路径 → 校验过的原生路径。
   * @param followFinal true = 最后一段是符号链接时也要求其目标在工作区内（读写内容）；
   *                    false = 只校验父目录（改名 / 删除只动链接本身）
   */
  async resolve(id: string, p: string, followFinal = true): Promise<string> {
    const scope = await this.resolveScope(id)
    const native = fromLocalPosix(p)
    if (process.platform === 'win32' && /^\\\\/.test(native)) throw new LocalPathError('不支持网络 / 设备路径。')
    const roots = [scope.root]
    if (!isInside(scope.root, native)) roots.push(...(await scope.extraRoots()))
    const lexical = roots.find((r) => isInside(r, native))
    if (lexical === undefined) throw new LocalPathError(`路径不在当前工作区内：${p}`)
    const real = followFinal ? await realpathLoose(native) : path.join(await realpathLoose(path.dirname(native)), path.basename(native))
    const realRoot = await realpathLoose(lexical)
    if (!isInside(realRoot, real) && !(native === lexical && !followFinal)) {
      throw new LocalPathError(`路径经符号链接指向工作区之外，已拒绝：${p}`)
    }
    return native
  }

  async home(id: string): Promise<string> {
    return toLocalPosix((await this.resolveScope(id)).root)
  }

  async list(id: string, dir: string): Promise<ListResult> {
    const target = await this.resolve(id, dir)
    const posixDir = toLocalPosix(target)
    const raw = await readdir(target, { withFileTypes: true })
    const truncated = raw.length > MAX_ENTRIES
    const kept = truncated ? raw.slice(0, MAX_ENTRIES) : raw
    const matcher = await this.matcherFor(target)
    const entries: RemoteEntry[] = []
    await Promise.all(
      kept.map(async (d) => {
        const full = path.join(target, d.name)
        const posix = posixDir === '/' ? `/${d.name}` : `${posixDir}/${d.name}`
        let info
        try {
          info = await lstat(full)
        } catch {
          return
        }
        const type = typeOfStats(info)
        const entry: RemoteEntry = {
          name: d.name,
          path: posix,
          type,
          size: info.size,
          mtime: Math.floor(info.mtimeMs),
          mode: info.mode & 0o7777,
          ignored: matcher.ignores(posix, type === 'dir'),
          hidden: d.name.startsWith('.')
        }
        if (type === 'symlink') {
          try {
            entry.linkTarget = await readlink(full)
          } catch {
            /* 无权限 */
          }
          try {
            entry.linkIsDir = (await stat(full)).isDirectory()
          } catch {
            entry.linkIsDir = false
          }
        }
        entries.push(entry)
      })
    )
    entries.sort((a, b) => {
      const ad = a.type === 'dir' || a.linkIsDir === true ? 0 : 1
      const bd = b.type === 'dir' || b.linkIsDir === true ? 0 : 1
      if (ad !== bd) return ad - bd
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return { path: posixDir, entries, truncated }
  }

  private async matcherFor(dir: string): Promise<IgnoreMatcher> {
    let gitignore: string | undefined
    try {
      const file = path.join(dir, '.gitignore')
      const s = await stat(file)
      if (s.isFile() && s.size <= 256 * 1024) gitignore = await readFile(file, 'utf8')
    } catch {
      /* 没有 .gitignore */
    }
    return buildMatcher(toLocalPosix(dir), this.userIgnore(), gitignore)
  }

  async readText(id: string, file: string, maxBytes: number): Promise<ReadResult> {
    const target = await this.resolve(id, file)
    const s = await stat(target)
    if (!s.isFile()) throw new Error('只能预览普通文件。')
    const limit = Math.min(s.size, maxBytes)
    const buffer = Buffer.alloc(limit)
    if (limit > 0) {
      const handle = await open(target, 'r')
      try {
        await handle.read(buffer, 0, limit, 0)
      } finally {
        await handle.close()
      }
    }
    const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    return {
      path: toLocalPosix(target),
      size: s.size,
      mtime: Math.floor(s.mtimeMs),
      content: binary ? '' : buffer.toString('utf8'),
      truncated: s.size > maxBytes,
      binary,
      lossy: !binary && !utf8RoundTrips(buffer, s.size > maxBytes)
    }
  }

  async readData(id: string, file: string, maxBytes: number): Promise<{ path: string; size: number; base64: string }> {
    const target = await this.resolve(id, file)
    const s = await stat(target)
    if (!s.isFile()) throw new Error('只能读取普通文件。')
    if (s.size > maxBytes) throw new Error(`文件过大（${s.size} 字节，上限 ${maxBytes}）。`)
    return { path: toLocalPosix(target), size: s.size, base64: (await readFile(target)).toString('base64') }
  }

  /** 保存：mtime 冲突检测 + 同目录临时文件改名（写到符号链接指向的真实文件）+ 保留权限位。 */
  async writeText(id: string, file: string, content: string, expectedMtime: number | undefined): Promise<{ path: string; size: number; mtime: number }> {
    const requested = await this.resolve(id, file)
    let target = requested
    let mode: number | undefined
    try {
      if ((await lstat(requested)).isSymbolicLink()) target = await realpath(requested)
      const s = await stat(target)
      if (!s.isFile()) throw new Error('只能保存到普通文件。')
      if (expectedMtime !== undefined && Math.floor(s.mtimeMs) !== expectedMtime) {
        throw new RemoteConflictError(toLocalPosix(requested), Math.floor(s.mtimeMs), s.size)
      }
      mode = s.mode & 0o7777
    } catch (error) {
      if (!isNotFound(error)) throw error
      if (expectedMtime !== undefined) throw new RemoteConflictError(toLocalPosix(requested), 0, 0)
    }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.dshws-${randomBytes(4).toString('hex')}.part`)
    const bytes = Buffer.from(content, 'utf8')
    try {
      await writeFile(tmp, bytes, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) })
      await renameRetry(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    const after = await stat(target)
    this.log.info('', 'local', `已保存 ${requested}（${bytes.length} 字节）`)
    return { path: toLocalPosix(requested), size: after.size, mtime: Math.floor(after.mtimeMs) }
  }

  async statPath(id: string, file: string): Promise<{ type: EntryType; size: number; mtimeMs: number } | undefined> {
    const target = await this.resolve(id, file)
    try {
      const s = await stat(target)
      return { type: typeOfStats(s), size: s.size, mtimeMs: s.mtimeMs }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async mkdir(id: string, parent: string, name: string): Promise<string> {
    const target = await this.resolve(id, path.posix.join(normalizeRemotePath(parent), validateName(name)), false)
    await mkdir(target)
    this.log.info('', 'local', `已新建目录 ${target}`)
    return toLocalPosix(target)
  }

  async createFile(id: string, parent: string, name: string): Promise<string> {
    const target = await this.resolve(id, path.posix.join(normalizeRemotePath(parent), validateName(name)), false)
    await writeFile(target, '', { flag: 'wx' }).catch((error: unknown) => {
      throw new Error(`新建文件失败（可能已存在同名文件）：${target}`, { cause: error })
    })
    this.log.info('', 'local', `已新建文件 ${target}`)
    return toLocalPosix(target)
  }

  async rename(id: string, from: string, newName: string): Promise<string> {
    const source = await this.resolve(id, from, false)
    const scope = await this.resolveScope(id)
    if (key(source) === key(scope.root)) throw new Error('不能重命名工作区根目录。')
    const target = path.join(path.dirname(source), validateName(newName))
    if (target === source) return toLocalPosix(source)
    // Windows 只改大小写（a.ts → A.ts）时目标「已存在」其实就是它自己，允许。
    if (key(target) !== key(source) && (await exists(target))) throw new RemoteExistsError(toLocalPosix(target))
    await rename(source, target)
    this.log.info('', 'local', `已重命名 ${source} → ${target}`)
    return toLocalPosix(target)
  }

  async copy(id: string, from: string, targetDir: string): Promise<string> {
    const source = await this.resolve(id, from, false)
    const dir = await this.resolve(id, targetDir)
    if (isInside(source, dir)) throw new Error(`不能把目录复制到它自己里面：${source} → ${dir}`)
    const srcStat = await lstat(source)
    if (!(await stat(dir)).isDirectory()) throw new Error(`目标不是目录：${dir}`)
    const nameAt = copyNameCandidates(path.basename(source), srcStat.isDirectory())
    let target: string | undefined
    for (let n = 0; n < 1000 && target === undefined; n++) {
      const candidate = path.join(dir, nameAt(n))
      if (!(await exists(candidate))) target = candidate
    }
    if (target === undefined) throw new Error(`找不到可用的复制目标名：${path.join(dir, path.basename(source))}`)
    await cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true })
    this.log.info('', 'local', `已复制 ${source} → ${target}`)
    return toLocalPosix(target)
  }

  /** 删除（目录递归）。拒绝删除工作区根目录本身；符号链接只删链接。 */
  async remove(id: string, target: string): Promise<RemoveResult> {
    const p = await this.resolve(id, target, false)
    const scope = await this.resolveScope(id)
    if (key(p) === key(scope.root)) throw new Error(`出于安全考虑，不允许删除工作区根目录：${p}`)
    const result: RemoveResult = { files: 0, dirs: 0 }
    const walk = async (q: string): Promise<void> => {
      if (result.files + result.dirs >= REMOVE_LIMIT) throw new Error(`待删除条目超过 ${REMOVE_LIMIT} 个，已中止。`)
      const s = await lstat(q)
      if (s.isDirectory()) {
        for (const child of await readdir(q)) await walk(path.join(q, child))
        await rmdir(q)
        result.dirs += 1
      } else {
        await rm(q, { force: false })
        result.files += 1
      }
    }
    try {
      await walk(p)
    } finally {
      this.log.info('', 'local', `删除 ${p}：${result.files} 个文件、${result.dirs} 个目录。`)
    }
    return result
  }

  /** 按文件名模糊搜索：递归遍历（忽略规则剪枝），有深度、数量与时间上限。 */
  async search(id: string, root: string, query: string, limit = 500): Promise<SearchResult> {
    const base = await this.resolve(id, root)
    const baseLp = toLocalPosix(base)
    const q = query.trim().toLowerCase()
    if (q === '') return { root: baseLp, matches: [], truncated: false, timedOut: false }
    const matcher = await this.matcherFor(base)
    const deadline = Date.now() + SEARCH_TIMEOUT_MS
    const matches: SearchResult['matches'] = []
    let truncated = false
    let timedOut = false
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > SEARCH_MAX_DEPTH || truncated || timedOut) return
      if (Date.now() > deadline) {
        timedOut = true
        return
      }
      let children
      try {
        children = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const d of children) {
        const full = path.join(dir, d.name)
        const lp = toLocalPosix(full)
        const isDir = d.isDirectory()
        if (matcher.ignores(lp, isDir)) continue
        if (d.name.toLowerCase().includes(q)) {
          if (matches.length >= limit) {
            truncated = true
            return
          }
          matches.push({ path: lp, type: isDir ? 'dir' : 'file' })
        }
        if (isDir) await walk(full, depth + 1)
      }
    }
    await walk(base, 1)
    return { root: baseLp, matches, truncated, timedOut }
  }

  async openDownload(id: string, file: string): Promise<{ stream: Readable; size: number; name: string }> {
    const target = await this.resolve(id, file)
    const s = await stat(target)
    if (!s.isFile()) throw new Error('只能下载普通文件。')
    return { stream: createReadStream(target), size: s.size, name: path.basename(target) }
  }

  async upload(id: string, dir: string, name: string, source: Readable, options: { overwrite: boolean }): Promise<{ path: string }> {
    const parent = await this.resolve(id, dir)
    const target = await this.resolve(id, path.posix.join(normalizeRemotePath(dir), validateName(name)), false)
    if (!(await stat(parent)).isDirectory()) throw new Error(`上传目标不是目录：${parent}`)
    const existed = await exists(target)
    if (existed && !options.overwrite) throw new RemoteExistsError(toLocalPosix(target))
    const tmp = path.join(parent, `.${path.basename(target)}.dshws-${randomBytes(4).toString('hex')}.part`)
    try {
      await pipeline(source, createWriteStream(tmp, { flags: 'wx' }))
      await renameRetry(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    this.log.info('', 'local', `已上传 ${target}${existed ? '（覆盖）' : ''}`)
    return { path: toLocalPosix(target) }
  }
}

/** Windows 上目标被杀毒 / 索引短暂占用时 rename 会失败，短暂重试（与 fs-atomic.ts 同一策略的异步版）。 */
async function renameRetry(from: string, to: string): Promise<void> {
  const backoff = [20, 40, 80, 120, 160, 200]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < backoff.length) {
        await new Promise((r) => setTimeout(r, backoff[attempt]))
        continue
      }
      throw error
    }
  }
}
