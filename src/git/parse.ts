/*
 * @Description: git 输出解析（纯函数，便于单测）—— status v2 / log / for-each-ref / name-status
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/git/parse.ts
 *
 * 一律用 -z / 控制字符分隔的机器格式：文件名里有空格、中文、换行都不会错位
 * （core.quotepath=false 另外保证中文不被转义成 \346\265...）。
 */

export interface GitFileStatus {
  path: string
  /** 重命名 / 复制时的原路径。 */
  origPath?: string
  /** 暂存区状态（X）：'.' 表示无变化。 */
  index: string
  /** 工作区状态（Y）。 */
  worktree: string
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked'
}

export interface GitStatus {
  isRepo: true
  branch: string | null
  /** 游离 HEAD 时的提交号。 */
  detached: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
}

/** git status --porcelain=v2 --branch -z --untracked-files=all */
export function parseStatusV2(out: string): Omit<GitStatus, 'isRepo'> {
  const tokens = out.split('\0')
  const result: Omit<GitStatus, 'isRepo'> = { branch: null, detached: null, upstream: null, ahead: 0, behind: 0, files: [] }
  let oid: string | null = null
  for (let i = 0; i < tokens.length; i += 1) {
    const line = tokens[i] as string
    if (line === '') continue
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') oid = value
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m !== null) {
          result.ahead = Number(m[1])
          result.behind = Number(m[2])
        }
      }
      continue
    }
    const type = line[0]
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = line.split(' ')
      const xy = parts[1] as string
      result.files.push({ path: parts.slice(8).join(' '), index: xy[0] as string, worktree: xy[1] as string, kind: 'changed' })
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = line.split(' ')
      const xy = parts[1] as string
      const origPath = tokens[i + 1] ?? ''
      i += 1
      result.files.push({ path: parts.slice(9).join(' '), origPath, index: xy[0] as string, worktree: xy[1] as string, kind: 'renamed' })
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = line.split(' ')
      const xy = parts[1] as string
      result.files.push({ path: parts.slice(10).join(' '), index: xy[0] as string, worktree: xy[1] as string, kind: 'unmerged' })
    } else if (type === '?') {
      result.files.push({ path: line.slice(2), index: '?', worktree: '?', kind: 'untracked' })
    }
  }
  if (result.branch === null && oid !== null && oid !== '(initial)') result.detached = oid.slice(0, 12)
  return result
}

export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  /** 作者时间（毫秒）。 */
  date: number
  /** 分支 / 标签装饰，如 ["HEAD -> main", "origin/main", "tag: v1"]。 */
  refs: string[]
  subject: string
}

/** git log 的格式：字段用 \x1f，记录用 \x1e。 */
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e'

export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of out.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '')
    if (trimmed === '') continue
    const [hash, parents, author, at, refs, subject] = trimmed.split('\x1f')
    if (hash === undefined || !/^[0-9a-f]{7,64}$/.test(hash)) continue
    commits.push({
      hash,
      parents: (parents ?? '').split(' ').filter(Boolean),
      author: author ?? '',
      date: Number(at ?? 0) * 1000,
      refs: (refs ?? '').split(', ').map((r) => r.trim()).filter(Boolean),
      subject: subject ?? ''
    })
  }
  return commits
}

export interface GitBranch {
  /** 完整引用名，如 refs/heads/main、refs/remotes/origin/main。 */
  ref: string
  name: string
  remote: boolean
  head: boolean
  commit: string
  upstream: string | null
}

export const BRANCH_FORMAT = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(HEAD)'

export function parseBranches(out: string): GitBranch[] {
  const branches: GitBranch[] = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const [ref, name, commit, upstream, head] = line.split('\x1f')
    if (ref === undefined || name === undefined) continue
    // origin/HEAD 这类符号引用对切换没有意义。
    if (ref.endsWith('/HEAD')) continue
    branches.push({
      ref,
      name,
      remote: ref.startsWith('refs/remotes/'),
      head: head === '*',
      commit: commit ?? '',
      upstream: upstream === undefined || upstream === '' ? null : upstream
    })
  }
  return branches
}

export interface GitTreeEntry {
  name: string
  /** 仓库内相对路径。 */
  path: string
  type: 'blob' | 'tree' | 'commit'
  /** 文件大小（字节）；目录 / 子模块为 undefined。 */
  size?: number
}

/** git ls-tree -z -l <rev>[:<dir>]：`<mode> <type> <hash> <size>\t<name>` 以 NUL 分隔。 */
export function parseLsTree(out: string, dir: string): GitTreeEntry[] {
  const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`
  const entries: GitTreeEntry[] = []
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [, type, , size] = record.slice(0, tab).split(/\s+/)
    const name = record.slice(tab + 1)
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') continue
    entries.push({ name, path: `${prefix}${name}`, type, ...(type === 'blob' && size !== undefined && size !== '-' ? { size: Number(size) } : {}) })
  }
  // 目录在前，名称自然序。
  entries.sort((a, b) => (a.type === 'tree' ? 0 : 1) - (b.type === 'tree' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  return entries
}

export interface GitWorktree {
  path: string
  /** 检出的分支完整引用名；游离 HEAD / bare 为 null。 */
  branch: string | null
  /** 目录已不存在（git 标记 prunable）。 */
  prunable: boolean
}

/** git worktree list --porcelain：每个工作目录一段，段间空行。第一段是主工作目录。 */
export function parseWorktrees(out: string): GitWorktree[] {
  const list: GitWorktree[] = []
  let cur: GitWorktree | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, prunable: false }
      list.push(cur)
    } else if (cur !== null && line.startsWith('branch ')) cur.branch = line.slice('branch '.length)
    else if (cur !== null && (line === 'prunable' || line.startsWith('prunable '))) cur.prunable = true
  }
  return list
}

/**
 * 可查看的引用：HEAD，或 refs/heads|remotes|tags/ 下的完整引用名。
 * 不接受任意表达式（HEAD~3、a..b、@{-1} 之类），执行前还会 rev-parse 解析成提交号。
 */
export function isViewableRef(ref: string): boolean {
  if (ref === 'HEAD') return true
  if (!/^refs\/(heads|remotes|tags)\/[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(ref)) return false
  return !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('/') && !ref.endsWith('.lock')
}

export interface GitChangedFile {
  status: string
  path: string
  origPath?: string
}

/** git diff / diff-tree --name-status -z -M */
export function parseNameStatus(out: string): GitChangedFile[] {
  const tokens = out.split('\0').filter((t) => t !== '')
  const files: GitChangedFile[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i] as string
    // diff-tree 输出第一个 token 可能是提交号（未加 --no-commit-id 时），跳过。
    if (/^[0-9a-f]{40}$/.test(status)) continue
    const letter = status[0] as string
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, origPath: tokens[i + 1] as string, path: tokens[i + 2] as string })
      i += 2
    } else {
      files.push({ status: letter, path: tokens[i + 1] as string })
      i += 1
    }
  }
  return files
}
