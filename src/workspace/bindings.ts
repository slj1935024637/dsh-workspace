/*
 * @Description: 远程工作区绑定 —— 本地占位目录 ↔ {主机, 远程路径}
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/workspace/bindings.ts
 *
 * DSH 的工作区必须是本机真实目录（workspaceRegistry 做 realpath + isDirectory），
 * 会话与工作区的绑定本质是会话的 cwd。所以远程工作区 = 一个本地占位目录 + 本表的一条记录。
 * Agent 运行时拿到的是会话 cwd，用它反查本表即知道该会话对应哪台主机、哪个远程目录。
 *
 * 主键用规范化后的占位目录路径，而不是 workspaceId：工作区删掉重加后 id 会变，路径不变。
 * 占位目录内另写一份 meta 文件作为双保险 —— 映射表丢失时可据此重建。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { renameWithRetry } from '../fs-atomic.js'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { WORKSPACE_META_FILE, bindingsFile, pluginRoot, safeSegment } from '../paths.js'

export interface RemoteBinding {
  /** 本地占位目录（绝对路径，创建时的原样写法）。 */
  localPath: string
  hostId: string
  /** 远程工作区根目录（POSIX 绝对路径）。 */
  remotePath: string
  title: string
  createdAt: string
}

interface MetaFile {
  kind: 'dsh-workspace/remote'
  version: 1
  hostId: string
  remotePath: string
  title: string
  createdAt: string
}

/** 占位目录的统一根：与保险箱等数据文件分开放。 */
export function remoteWorkspacesRoot(): string {
  return path.join(pluginRoot(), 'remote')
}

/**
 * 路径的比较键：绝对化、尽量 realpath、Windows 下忽略大小写。
 * 会话 cwd 与创建时的写法可能在大小写、符号链接、结尾斜杠上不同，统一后再比较。
 */
export function pathKey(p: string): string {
  let resolved = path.resolve(p)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    /* 目录已不存在：按字面比较 */
  }
  resolved = resolved.replace(/[\\/]+$/, '')
  return caseInsensitiveFs() ? resolved.toLowerCase() : resolved
}

/**
 * 本机文件系统是否不区分大小写：Windows（NTFS）与 macOS（APFS / HFS+ 默认）是，Linux 不是。
 * macOS 的 realpath 不会把大小写规范化，会话 cwd 与登记路径只差大小写时要靠这里兜住。
 */
export function caseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * 目录名：保留中文等 Unicode 字符（工作区标题默认取目录名，全变成下划线就没法看了），
 * 只替换 Windows 文件名非法字符，并去掉结尾的点与空格（Windows 会静默吞掉）。
 */
export function folderName(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  // 带扩展名的也是保留名（aux.api、con.d 在 Windows 上同样建不出来）。
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
  if (cleaned === '' || reserved.test(cleaned)) return `_${cleaned}`
  return cleaned.slice(0, 120)
}

export class BindingStore {
  private data: Map<string, RemoteBinding> | undefined

  constructor(private readonly file: () => string = bindingsFile) {}

  private load(): Map<string, RemoteBinding> {
    if (this.data !== undefined) return this.data
    const map = new Map<string, RemoteBinding>()
    const file = this.file()
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { bindings?: RemoteBinding[] }
        for (const b of parsed.bindings ?? []) {
          if (typeof b?.localPath === 'string' && typeof b.hostId === 'string' && typeof b.remotePath === 'string') {
            map.set(pathKey(b.localPath), b)
          }
        }
      } catch {
        // 映射表损坏：不抛错，保持为空 —— 会话仍可按占位目录里的 meta 文件恢复。
      }
    }
    this.data = map
    return map
  }

  private persist(): void {
    const file = this.file()
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, bindings: [...this.load().values()] }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(tmp, file)
  }

  list(): RemoteBinding[] {
    return [...this.load().values()]
  }

  /**
   * 按会话 cwd（或其下任意子目录）查绑定。
   * 先查映射表；查不到再看目录里的 meta 文件（映射表丢失时自愈并补登记）。
   */
  resolve(cwd: string | undefined): RemoteBinding | undefined {
    if (cwd === undefined || cwd === '') return undefined
    const map = this.load()
    let current = pathKey(cwd)
    // 自下而上找：会话 cwd 一般就是占位目录本身，但也兼容其子目录。
    for (let i = 0; i < 64; i += 1) {
      const hit = map.get(current)
      if (hit !== undefined) return hit
      const recovered = this.fromMeta(current)
      if (recovered !== undefined) return recovered
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return undefined
  }

  private fromMeta(dir: string): RemoteBinding | undefined {
    const metaPath = path.join(dir, WORKSPACE_META_FILE)
    if (!existsSync(metaPath)) return undefined
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<MetaFile>
      if (meta.kind !== 'dsh-workspace/remote' || typeof meta.hostId !== 'string' || typeof meta.remotePath !== 'string') {
        return undefined
      }
      const binding: RemoteBinding = {
        localPath: dir,
        hostId: meta.hostId,
        remotePath: meta.remotePath,
        title: typeof meta.title === 'string' ? meta.title : path.basename(dir),
        createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : new Date().toISOString()
      }
      this.load().set(pathKey(dir), binding)
      this.persist()
      return binding
    } catch {
      return undefined
    }
  }

  /**
   * 创建远程工作区的占位目录并登记。
   * 同一主机的同一远程目录再次创建时返回已有记录（幂等），与 DSH 同路径创建工作区的幂等一致。
   * 目录名撞车（同名、但指向不同远程目录）时追加短哈希区分。
   */
  create(input: { hostId: string; endpoint: string; remotePath: string; title: string }): RemoteBinding {
    const existing = this.list().find((b) => b.hostId === input.hostId && b.remotePath === input.remotePath)
    if (existing !== undefined && existsSync(existing.localPath)) return existing

    const parent = path.join(remoteWorkspacesRoot(), safeSegment(input.endpoint))
    let dir = path.join(parent, folderName(input.title))
    const occupied = (candidate: string): boolean => {
      const other = this.load().get(pathKey(candidate))
      return (other !== undefined && (other.hostId !== input.hostId || other.remotePath !== input.remotePath)) ||
        (existsSync(candidate) && this.fromMetaNoPersist(candidate)?.remotePath !== input.remotePath)
    }
    if (occupied(dir)) {
      const tag = createHash('sha256').update(`${input.hostId}\n${input.remotePath}`).digest('hex').slice(0, 6)
      dir = `${dir}-${tag}`
    }
    mkdirSync(dir, { recursive: true })

    const binding: RemoteBinding = {
      localPath: dir,
      hostId: input.hostId,
      remotePath: input.remotePath,
      title: input.title,
      createdAt: new Date().toISOString()
    }
    const meta: MetaFile = {
      kind: 'dsh-workspace/remote',
      version: 1,
      hostId: binding.hostId,
      remotePath: binding.remotePath,
      title: binding.title,
      createdAt: binding.createdAt
    }
    writeFileSync(path.join(dir, WORKSPACE_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    this.load().set(pathKey(dir), binding)
    this.persist()
    return binding
  }

  private fromMetaNoPersist(dir: string): { remotePath: string } | undefined {
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, WORKSPACE_META_FILE), 'utf8')) as Partial<MetaFile>
      return typeof meta.remotePath === 'string' ? { remotePath: meta.remotePath } : undefined
    } catch {
      return undefined
    }
  }

  /** 更新标题（工作区改名时同步）。 */
  rename(localPath: string, title: string): void {
    const b = this.load().get(pathKey(localPath))
    if (b === undefined) return
    b.title = title
    this.persist()
  }

  /** 解除登记（不删占位目录：DSH 的会话记录仍引用它）。 */
  remove(localPath: string): boolean {
    const removed = this.load().delete(pathKey(localPath))
    if (removed) this.persist()
    return removed
  }
}

/**
 * 把模型给出的路径映射到远程绝对路径。
 * - 远程绝对路径（/home/...）原样使用
 * - 以占位目录开头的本地绝对路径（模型照抄了会话 cwd）换成远程根
 * - 相对路径相对远程根
 * 结果一律 POSIX 规范化（折叠 . 与 ..）。
 */
export function toRemotePath(binding: RemoteBinding, input: string): string {
  const raw = input.trim()
  let remote: string
  // 顺序很重要：先判断「是否位于占位目录下」，再把 / 开头的当远程路径。
  // macOS / Linux 的占位目录本身就以 / 开头（/Users/me/.dsh/...），先判远程会把本机路径原样发给远端。
  const rel = isWindowsAbsolute(raw) || path.isAbsolute(raw) ? localRelative(binding.localPath, path.resolve(raw)) : undefined
  if (rel !== undefined) {
    remote = rel === '' ? binding.remotePath : `${binding.remotePath}/${rel}`
  } else if (raw.startsWith('/') && !isWindowsAbsolute(raw)) {
    remote = raw
  } else if (isWindowsAbsolute(raw) || path.isAbsolute(raw)) {
    throw new Error(`远程工作区中不能访问本机路径：${raw}。请使用远程路径（如 ${binding.remotePath}/...）或相对路径。`)
  } else {
    remote = `${binding.remotePath}/${raw}`
  }
  const normalized = path.posix.normalize(remote.replace(/\\/g, '/'))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * target 位于 root 之下时返回 POSIX 形式的相对路径（root 本身为 ''），否则 undefined。
 * 字面路径与 realpath 两种写法都试：家目录 / DSH_HOME 可能是符号链接（Linux /home → /data/home、
 * macOS /var → /private/var），会话 cwd 与登记时的写法未必一致。Windows 的 path.relative 本身不区分大小写。
 */
function localRelative(root: string, target: string): string | undefined {
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  for (const r of [root, real(root)]) {
    for (const t of [target, real(target)]) {
      const rel = path.relative(r, t)
      if (rel === '') return ''
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
      // macOS：posix 的 path.relative 区分大小写，文件系统却不区分。只按不区分大小写比较根部分，
      // 余下部分保留原样（它要发往远端，远端 Linux 区分大小写）。
      if (process.platform === 'darwin') {
        const rr = r.replace(/\/+$/, '')
        const lower = t.toLowerCase()
        if (lower === rr.toLowerCase()) return ''
        if (lower.startsWith(`${rr.toLowerCase()}/`)) return t.slice(rr.length + 1)
      }
    }
  }
  return undefined
}

function isWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** 远程路径相对远程根的显示形式（glob / grep 输出用），不在根下时返回绝对路径。 */
export function relativeToRoot(binding: RemoteBinding, remote: string): string {
  const root = binding.remotePath.replace(/\/+$/, '') || '/'
  if (remote === root) return '.'
  if (root === '/') return remote.slice(1)
  return remote.startsWith(`${root}/`) ? remote.slice(root.length + 1) : remote
}
