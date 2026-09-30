/*
 * @Description: 宿主机本地目录浏览 —— 宿主目录选择器只提供 native（系统对话框）时，「添加工作区」的应用内浏览由这里兜底
 * @Author: YangHeng
 * @Date: 2026-09-30 11:20:00
 * @FilePath: /dsh-workspace/src/local/browse.ts
 *
 * 为什么需要：DSH 的目录选择能力按平台组合成 browse 或 native 二选一，macOS 桌面版是 native，
 * uiWorkspace.listDirectory 固定报 directory-picker/unavailable，插件的应用内浏览就用不了。
 * 这里只做「列子目录 / 新建一级目录 / 列盘符」三件事，不读文件内容；
 * 与宿主 browse 能力暴露的范围一致（同样挡在宿主 RPC 的信任围栏之后）。
 *
 * 平台差异：
 * - Windows：盘符根 `C:\`；部分网盘挂载（如 115）对空目录的枚举报 EINVAL / ENOENT，确认是目录后按空目录返回。
 * - macOS：读 ~/Desktop、~/Documents、~/Downloads 会触发系统「隐私与安全」授权弹窗（由系统管理，拒绝时报 EPERM）。
 * - Linux / macOS：以 . 开头为隐藏；Node 读不到 Windows 的隐藏属性，Windows 上的隐藏由浏览器端按名字补判。
 */
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface LocalEntry {
  name: string
  path: string
  hidden: boolean
}

export interface LocalListing {
  path: string
  home: string
  entries: LocalEntry[]
  truncated: boolean
  /** Windows 且列的是起始目录时附带：存在的盘符根（`C:\` 形式）。 */
  drives?: string[]
}

/** 单次最多返回的子目录数，防止超大目录拖垮界面。 */
const MAX_ENTRIES = 2000
/** 单个盘符的探测超时：断开的网络盘 / 光驱可能很慢。 */
const DRIVE_PROBE_MS = 1500

export class LocalBrowseError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'unreadable' | 'exists' | 'create-failed'
  ) {
    super(message)
    this.name = 'LocalBrowseError'
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** 只接受绝对路径；规范化掉 `..`，Windows 的裸盘符 `C:` 补成 `C:\`。 */
export function resolveLocalPath(input: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (input === undefined || input.trim() === '') return os.homedir()
  const p = platform === 'win32' ? path.win32 : path.posix
  let value = input.trim()
  if (platform === 'win32' && /^[a-zA-Z]:$/.test(value)) value = `${value}\\`
  if (!p.isAbsolute(value)) throw new LocalBrowseError(`不是绝对路径：${input}`, 'invalid')
  return p.resolve(value)
}

/** 列出一个目录下的子目录（含指向目录的符号链接）。 */
export async function listLocalDirectory(input: string | undefined, platform: NodeJS.Platform = process.platform): Promise<LocalListing> {
  const dir = resolveLocalPath(input, platform)
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  let names: Array<{ name: string; dir: boolean; link: boolean }>
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    names = dirents.map((d) => ({ name: d.name, dir: d.isDirectory(), link: d.isSymbolicLink() }))
  } catch (error) {
    const code = codeOf(error)
    // 网盘挂载的空目录：枚举失败但 stat 是目录 —— 当空目录处理（与浏览器端 isEmptyDirQuirk 同一现象）。
    if ((code === 'EINVAL' || code === 'ENOENT') && (await isDirectory(dir))) names = []
    else throw new LocalBrowseError(`无法列出 ${dir}：${error instanceof Error ? error.message : String(error)}`, 'unreadable')
  }
  const entries: LocalEntry[] = []
  for (const n of names) {
    const full = join(dir, n.name)
    const isDir = n.dir || (n.link && (await isDirectory(full)))
    if (!isDir) continue
    entries.push({ name: n.name, path: full, hidden: n.name.startsWith('.') })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  const listing: LocalListing = {
    path: dir,
    home: os.homedir(),
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES
  }
  if (platform === 'win32' && (input === undefined || input.trim() === '')) listing.drives = await probeDrives()
  return listing
}

/** 在 parent 下新建一级目录；name 必须是单段。 */
export async function makeLocalDirectory(parent: string, name: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const dir = resolveLocalPath(parent, platform)
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed) || (platform === 'win32' && /[<>:"|?*]/.test(trimmed))) {
    throw new LocalBrowseError(`文件夹名称不合法：${name}`, 'invalid')
  }
  const target = (platform === 'win32' ? path.win32 : path.posix).join(dir, trimmed)
  try {
    await mkdir(target)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') throw new LocalBrowseError(`已存在：${target}`, 'exists')
    throw new LocalBrowseError(`无法新建 ${target}：${error instanceof Error ? error.message : String(error)}`, 'create-failed')
  }
  return target
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Windows：逐个盘符试探，能访问的就是存在的盘。 */
async function probeDrives(): Promise<string[]> {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const found = await Promise.all(
    letters.map(async (l) => {
      const root = `${l}:\\`
      const timeout = new Promise<false>((resolve) => {
        const t = setTimeout(() => resolve(false), DRIVE_PROBE_MS)
        t.unref?.()
      })
      const ok = access(root).then(
        () => true,
        () => false
      )
      return (await Promise.race([ok, timeout])) ? root : null
    })
  )
  return found.filter((r): r is string => r !== null)
}
