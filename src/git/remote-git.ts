/*
 * @Description: 在远程工作区里执行 git（经 SSH），供右侧栏「远程 Git」面板使用
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/git/remote-git.ts
 *
 * 安全边界：
 * - 只在「已登记的远程工作区根目录」里执行（由网关校验根目录属于该主机的绑定）
 * - 文件路径必须是仓库内相对路径（不许绝对路径、不许 ..），一律放在 -- 之后，不会被当成选项
 * - 查看分支只接受完整引用名（refs/heads|remotes|tags/…），先 rev-parse 成提交号再使用
 * - 不做检出：查看其他分支全程只读对象库，不改 HEAD、暂存区与工作区
 * - 所有参数单引号转义后拼接（sq）
 */
import { createHash } from 'node:crypto'
import { sq } from '../agent/backend.js'
import type { WorkspaceRuntime } from '../runtime.js'
import { execCapture } from '../sftp/exec.js'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStatusV2,
  parseLsTree,
  parseWorktrees,
  isViewableRef,
  type GitWorktree,
  type GitTreeEntry,
  type GitBranch,
  type GitChangedFile,
  type GitCommit,
  type GitStatus
} from './parse.js'

export type { GitBranch, GitChangedFile, GitCommit, GitStatus, GitTreeEntry }

/** diff 两侧内容的单边上限：超过就只提示「文件过大」，不把几十 MB 塞进浏览器。 */
const DIFF_SIDE_MAX = 2 * 1024 * 1024

export interface DiffSides {
  original: string
  modified: string
  binary: boolean
  tooLarge: boolean
}

interface RunOpts {
  timeoutMs?: number
  maxBytes?: number
  index?: string
  input?: string
}

/**
 * 查看分支时的编辑方式（每次写操作前都会重新判断，对用户无感）：
 * - worktree：就是远程目录当前检出的分支 —— 直接读写文件，改动 / 提交走普通 git status / commit
 * - index：其他本地分支 —— 改动存在本插件的临时索引里，提交用 commit-tree + update-ref，不碰工作目录
 * - worktree 也包括「在另一个 git worktree 里检出的分支」：直接在那个目录里改、提交
 * - readonly：远程分支 / 标签（需先建本地分支），或检出所在目录已被删除的分支
 */
export interface BranchInfo {
  mode: 'worktree' | 'index' | 'readonly'
  /** worktree 模式：直接读写、提交所在的远程目录（当前分支 = 工作区根；另一个 git worktree = 那个目录）。 */
  worktreePath?: string
  reason?: 'remote' | 'tag' | 'otherWorktree'
  /** 分支当前指向的提交。 */
  tip: string
  /** 未提交改动数（index 模式）。 */
  pending: number
}

export type DiffTarget =
  | { kind: 'worktree'; path: string; untracked?: boolean }
  | { kind: 'staged'; path: string }
  | { kind: 'branch'; ref: string; path: string; origPath?: string }
  | { kind: 'commit'; hash: string; parent: string | null; path: string; origPath?: string }

export class GitError extends Error {}

/** 仓库内相对路径校验。 */
export function checkRepoPath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new GitError(`非法路径：${p}`)
  }
  return normalized
}

export function checkHash(h: string): string {
  if (!/^[0-9a-f]{7,64}$/.test(h)) throw new GitError(`非法提交号：${h}`)
  return h
}

export class RemoteGit {
  constructor(
    private readonly rt: WorkspaceRuntime,
    private readonly hostId: string,
    private readonly root: string
  ) {}

  /**
   * 执行一条 git 命令；返回原始结果（非零退出码不抛错，由调用方判断）。
   * index：改用该临时索引文件（GIT_INDEX_FILE）—— 编辑非检出分支时用，不碰工作目录真正的暂存区。
   */
  private async run(args: string, options: RunOpts = {}) {
    const connection = await this.rt.pool.acquire(this.hostId, 'agent', () => this.rt.resolveHost(this.hostId))
    const env = options.index === undefined ? '' : `GIT_INDEX_FILE=${sq(options.index)} `
    // core.quotepath=false：中文路径原样输出；color.ui=never：不夹带颜色控制符。
    const command = `cd ${sq(this.root)} && ${env}git -c core.quotepath=false -c color.ui=never ${args}`
    return await execCapture(connection, command, {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
      ...(options.input !== undefined ? { input: options.input } : {})
    })
  }

  /** 在仓库根目录执行一条非 git 的 shell 命令（只用于读写本插件自己的临时索引文件）。 */
  private async sh(command: string) {
    const connection = await this.rt.pool.acquire(this.hostId, 'agent', () => this.rt.resolveHost(this.hostId))
    return await execCapture(connection, `cd ${sq(this.root)} && ${command}`, { timeoutMs: 30_000, maxBytes: 1 << 20 })
  }

  private async runOk(args: string, options?: RunOpts): Promise<string> {
    const r = await this.run(args, options)
    if (r.timedOut) throw new GitError(`git 命令超时：git ${args.slice(0, 80)}`)
    if (r.code !== 0) throw new GitError((r.stderr.trim() || r.stdout.trim() || `git 退出码 ${String(r.code)}`).slice(0, 2000))
    return r.stdout
  }

  async status(): Promise<GitStatus | { isRepo: false; reason: string }> {
    const r = await this.run('status --porcelain=v2 --branch -z --untracked-files=all')
    if (r.code !== 0) {
      const reason = r.stderr.trim()
      if (/not a git repository/i.test(reason)) return { isRepo: false, reason: '该目录不是 Git 仓库。' }
      if (/command not found|not found/i.test(reason)) return { isRepo: false, reason: '远程主机未安装 git。' }
      throw new GitError(reason || `git status 失败（退出码 ${String(r.code)}）`)
    }
    return { isRepo: true, ...parseStatusV2(r.stdout) }
  }

  /** 提交历史：不传引用为全部分支；传引用则只看该分支（查看其他分支时用）。 */
  async log(skip: number, limit: number, ref?: string): Promise<GitCommit[]> {
    const scope = ref === undefined ? '--all' : await this.resolve(ref)
    // --decorate=full：装饰给出完整引用名（refs/remotes/…、tag: refs/tags/…），界面据此准确区分远程 / 本地 / 标签。
    const r = await this.run(`log ${scope} --decorate=full --topo-order --skip=${Math.max(0, skip | 0)} -n ${Math.min(1000, Math.max(1, limit | 0))} --format=${sq(LOG_FORMAT)}`)
    // 空仓库（还没有提交）时 log 报错：视为没有历史。
    if (r.code !== 0) {
      if (/does not have any commits|bad default revision|unknown revision/i.test(r.stderr)) return []
      throw new GitError(r.stderr.trim() || 'git log 失败')
    }
    return parseLog(r.stdout)
  }

  async branches(): Promise<GitBranch[]> {
    return parseBranches(await this.runOk(`for-each-ref --sort=-committerdate --format=${sq(BRANCH_FORMAT)} refs/heads refs/remotes`))
  }

  /** 某个提交改了哪些文件（合并提交相对第一个父提交）。 */
  async show(hash: string, parent: string | null): Promise<GitChangedFile[]> {
    const h = checkHash(hash)
    const out =
      parent === null
        ? await this.runOk(`diff-tree --no-commit-id --root -r -z -M --name-status ${h}`)
        : await this.runOk(`diff -z -M --name-status ${checkHash(parent)} ${h}`)
    return parseNameStatus(out)
  }

  /** 取某个版本的文件内容；不存在返回 ''。index 给出时 `:路径` 读该临时索引里的版本。 */
  private async blob(spec: string, index?: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
    const r = await this.run(`show ${sq(spec)}`, { maxBytes: DIFF_SIDE_MAX + 1, ...(index !== undefined ? { index } : {}) })
    if (r.code !== 0 && !r.truncated) return { text: '', binary: false, tooLarge: false }
    return sideOf(r.stdout, r.truncated)
  }

  private async worktreeFile(path: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
    const connection = await this.rt.pool.acquire(this.hostId, 'agent', () => this.rt.resolveHost(this.hostId))
    const r = await execCapture(connection, `cd ${sq(this.root)} && cat -- ${sq(path)}`, { timeoutMs: 30_000, maxBytes: DIFF_SIDE_MAX + 1 })
    if (r.code !== 0 && !r.truncated) return { text: '', binary: false, tooLarge: false }
    return sideOf(r.stdout, r.truncated)
  }

  async diff(target: DiffTarget): Promise<DiffSides> {
    const path = checkRepoPath(target.path)
    let a: { text: string; binary: boolean; tooLarge: boolean }
    let b: { text: string; binary: boolean; tooLarge: boolean }
    if (target.kind === 'worktree') {
      // 未暂存改动：暂存区（没有则 HEAD / 空）→ 工作区。
      a = target.untracked === true ? { text: '', binary: false, tooLarge: false } : await this.blob(`:${path}`)
      b = await this.worktreeFile(path)
    } else if (target.kind === 'staged') {
      a = await this.blob(`HEAD:${path}`)
      b = await this.blob(`:${path}`)
    } else if (target.kind === 'branch') {
      // 分支上未提交的改动：基准提交 → 临时索引。
      const { index, base } = await this.pendingState(target.ref)
      const orig = target.origPath === undefined ? path : checkRepoPath(target.origPath)
      a = base === null ? { text: '', binary: false, tooLarge: false } : await this.blob(`${base}:${orig}`)
      b = index === null ? a : await this.blob(`:${path}`, index)
    } else {
      const hash = checkHash(target.hash)
      const orig = target.origPath === undefined ? path : checkRepoPath(target.origPath)
      a = target.parent === null ? { text: '', binary: false, tooLarge: false } : await this.blob(`${checkHash(target.parent)}:${orig}`)
      b = await this.blob(`${hash}:${path}`)
    }
    return { original: a.text, modified: b.text, binary: a.binary || b.binary, tooLarge: a.tooLarge || b.tooLarge }
  }

  private pathArgs(paths: readonly string[]): string {
    if (paths.length === 0) throw new GitError('没有选择文件')
    return paths.map((p) => sq(checkRepoPath(p))).join(' ')
  }

  async stage(paths: readonly string[]): Promise<void> {
    await this.runOk(`add -A -- ${this.pathArgs(paths)}`)
  }

  async unstage(paths: readonly string[]): Promise<void> {
    const hasHead = (await this.run('rev-parse --verify -q HEAD')).code === 0
    // 还没有任何提交时没有 HEAD 可以 reset，只能从暂存区移除。
    await this.runOk(hasHead ? `reset -q -- ${this.pathArgs(paths)}` : `rm --cached -r -q -- ${this.pathArgs(paths)}`)
  }

  /** 丢弃工作区改动：已跟踪文件恢复为暂存区版本；未跟踪文件删除。 */
  async discard(tracked: readonly string[], untracked: readonly string[]): Promise<void> {
    if (tracked.length > 0) await this.runOk(`checkout -- ${this.pathArgs(tracked)}`)
    if (untracked.length > 0) await this.runOk(`clean -f -q -- ${this.pathArgs(untracked)}`)
  }

  async commit(message: string): Promise<string> {
    const text = message.trim()
    if (text === '') throw new GitError('提交说明不能为空')
    await this.runOk(`commit -q -m ${sq(text)}`)
    return (await this.runOk('rev-parse --short HEAD')).trim()
  }

  // ---------------------------------------------------------------- 只读查看其他分支（不检出）

  /** 引用 → 提交号。只接受可查看的引用；不存在时报错。 */
  async resolve(ref: string): Promise<string> {
    if (!isViewableRef(ref)) throw new GitError(`非法引用：${ref}`)
    const r = await this.run(`rev-parse --verify -q ${sq(`${ref}^{commit}`)}`)
    const hash = r.stdout.trim()
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(hash)) throw new GitError(`找不到分支或提交：${ref}`)
    return hash
  }

  /**
   * 某个引用下某个目录的内容：ls-tree 直接读对象库，不碰工作区。
   * 该分支有未提交改动时，读临时索引生成的目录快照（write-tree 只写对象库），新增 / 删除的文件也能反映出来。
   */
  async tree(ref: string, dir: string): Promise<{ hash: string; entries: GitTreeEntry[] }> {
    const hash = await this.resolve(ref)
    const { index } = await this.pendingState(ref)
    const treeish = index === null ? hash : (await this.runOk('write-tree', { index })).trim()
    const d = dir === '' ? '' : checkRepoPath(dir).replace(/\/+$/, '')
    const out = await this.runOk(`ls-tree -z -l ${sq(d === '' ? treeish : `${treeish}:${d}`)}`)
    return { hash, entries: parseLsTree(out, d) }
  }

  /** 某个引用下某个文件的内容（有未提交改动时读临时索引里的版本），不碰工作区。 */
  async file(ref: string, path: string): Promise<{ hash: string; text: string; binary: boolean; tooLarge: boolean }> {
    const hash = await this.resolve(ref)
    const p = checkRepoPath(path)
    const { index } = await this.pendingState(ref)
    const side = index === null ? await this.blob(`${hash}:${p}`) : await this.blob(`:${p}`, index)
    return { hash, ...side }
  }

  // ---------------------------------------------------------------- 编辑非检出分支（临时索引）

  private gitDirCache: string | undefined

  private async gitDir(): Promise<string> {
    if (this.gitDirCache === undefined) this.gitDirCache = (await this.runOk('rev-parse --absolute-git-dir')).trim()
    return this.gitDirCache
  }

  /** 某分支的临时索引与「基准提交」记录文件（放在 .git 里，不占工作目录、不进版本库）。 */
  private async indexFiles(ref: string): Promise<{ dir: string; index: string; baseFile: string }> {
    const dir = `${await this.gitDir()}/dsh-workspace`
    const key = createHash('sha1').update(ref).digest('hex').slice(0, 16)
    return { dir, index: `${dir}/idx-${key}`, baseFile: `${dir}/idx-${key}.base` }
  }

  /** 临时索引现状：不存在时 index / base 为 null。 */
  private async pendingState(ref: string): Promise<{ index: string | null; base: string | null }> {
    if (!isViewableRef(ref) || !ref.startsWith('refs/heads/')) return { index: null, base: null }
    const f = await this.indexFiles(ref)
    const r = await this.sh(`test -f ${sq(f.index)} && cat ${sq(f.baseFile)}`)
    const base = r.stdout.trim()
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(base)) return { index: null, base: null }
    return { index: f.index, base }
  }

  /** 判断该分支的编辑方式（见 BranchInfo）。每次写操作前都会调用。 */
  async branchInfo(ref: string): Promise<BranchInfo> {
    const tip = await this.resolve(ref)
    if (ref.startsWith('refs/remotes/')) return { mode: 'readonly', reason: 'remote', tip, pending: 0 }
    if (ref.startsWith('refs/tags/') || ref === 'HEAD') return { mode: 'readonly', reason: 'tag', tip, pending: 0 }
    const head = (await this.run('symbolic-ref -q HEAD')).stdout.trim()
    if (head === ref) return { mode: 'worktree', worktreePath: this.root, tip, pending: 0 }
    // 在另一个 git worktree 里检出的分支：不能走临时索引（改引用会让那个目录与提交对不上），
    // 而是直接在那个目录里改文件、提交 —— 与当前分支同一种方式，用户无感。
    const other = (await this.worktrees()).find((w) => w.branch === ref)
    if (other !== undefined) {
      if (other.prunable) return { mode: 'readonly', reason: 'otherWorktree', tip, pending: 0 }
      return { mode: 'worktree', worktreePath: await this.mapToWorktree(other.path), tip, pending: 0 }
    }
    return { mode: 'index', tip, pending: (await this.branchChanges(ref)).files.length }
  }

  /** 本仓库的全部 git 工作目录（第一个是主工作目录）。 */
  async worktrees(): Promise<GitWorktree[]> {
    const r = await this.run('worktree list --porcelain')
    return r.code === 0 ? parseWorktrees(r.stdout) : []
  }

  /**
   * 工作区根目录可能是仓库的子目录：换到另一个工作目录时保持同样的子目录
   * （/repo/sub → /wt/feature/sub），文件树与本分支看到的范围一致。
   */
  private async mapToWorktree(worktreeTop: string): Promise<string> {
    const top = (await this.runOk('rev-parse --show-toplevel')).trim().replace(/\/+$/, '')
    const root = this.root.replace(/\/+$/, '')
    const rel = root === top ? '' : root.startsWith(`${top}/`) ? root.slice(top.length) : ''
    return `${worktreeTop.replace(/\/+$/, '')}${rel}`
  }

  /** 某路径是不是本仓库某个工作目录（含映射后的子目录）：网关据此允许在该目录执行 git。 */
  async isOwnWorktree(path: string): Promise<boolean> {
    const target = path.replace(/\/+$/, '')
    if (target === this.root.replace(/\/+$/, '')) return true
    return (await this.worktreeRoots()).includes(target)
  }

  /** 本仓库各工作目录（映射到与工作区根相同的子目录；不含已删除的）。不是 git 仓库时为空。 */
  async worktreeRoots(): Promise<string[]> {
    const roots: string[] = []
    for (const w of await this.worktrees()) if (!w.prunable) roots.push(await this.mapToWorktree(w.path))
    return roots
  }

  private async requireIndexMode(ref: string): Promise<BranchInfo> {
    const info = await this.branchInfo(ref)
    if (info.mode === 'worktree') throw new GitError('该分支已是远程目录当前检出的分支，请刷新后在改动页操作。')
    if (info.mode === 'readonly') throw new GitError(info.reason === 'otherWorktree' ? '该分支检出所在的工作目录已不存在（可在终端执行 git worktree prune）。' : '远程分支与标签不能直接修改，请先基于它新建本地分支。')
    return info
  }

  /**
   * 确保临时索引存在并基于分支最新提交。
   * 已有索引但没有未提交改动、而分支在此期间前进了：跟着前进（否则之后的改动会基于旧版本）。
   */
  private async ensureIndex(ref: string, tip: string): Promise<string> {
    const f = await this.indexFiles(ref)
    const state = await this.pendingState(ref)
    if (state.index !== null && state.base === tip) return state.index
    if (state.index !== null && state.base !== null) {
      const pending = parseNameStatus(await this.runOk(`diff-index --cached -z -M --name-status ${state.base}`, { index: state.index }))
      if (pending.length > 0) return state.index
    }
    await this.sh(`mkdir -p ${sq(f.dir)}`)
    await this.runOk(`read-tree ${tip}`, { index: f.index })
    const w = await this.sh(`printf %s ${sq(tip)} > ${sq(f.baseFile)}`)
    if (w.code !== 0) throw new GitError(`无法写入临时索引：${w.stderr.trim()}`)
    return f.index
  }

  /** 分支上未提交的改动（临时索引相对基准提交）。 */
  async branchChanges(ref: string): Promise<{ base: string | null; files: GitChangedFile[] }> {
    const { index, base } = await this.pendingState(ref)
    if (index === null || base === null) return { base: null, files: [] }
    return { base, files: parseNameStatus(await this.runOk(`diff-index --cached -z -M --name-status ${base}`, { index })) }
  }

  /** 保存一个文件到分支（写入临时索引，尚未提交）。 */
  async branchSave(ref: string, path: string, content: string): Promise<void> {
    const p = checkRepoPath(path)
    const info = await this.requireIndexMode(ref)
    const index = await this.ensureIndex(ref, info.tip)
    const blob = (await this.runOk('hash-object -w --stdin', { input: content })).trim()
    if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new GitError('写入文件内容失败')
    // 保留原文件的权限位（如可执行脚本 100755）；新文件用 100644。
    const existing = (await this.runOk(`ls-files -s -z -- ${sq(p)}`, { index })).split(/\s/)[0]
    const mode = existing !== undefined && /^1[0-7]{5}$/.test(existing) ? existing : '100644'
    await this.runOk(`update-index --add --cacheinfo ${mode} ${blob} ${sq(p)}`, { index })
  }

  /** 撤销分支上某些文件的未提交改动（临时索引里恢复为基准版本）。 */
  async branchRevert(ref: string, paths: readonly string[]): Promise<void> {
    await this.requireIndexMode(ref)
    const { index, base } = await this.pendingState(ref)
    if (index === null || base === null) return
    await this.runOk(`reset -q ${base} -- ${this.pathArgs(paths)}`, { index })
  }

  /** 丢弃分支上全部未提交改动。 */
  async branchDiscard(ref: string): Promise<void> {
    if (!isViewableRef(ref) || !ref.startsWith('refs/heads/')) throw new GitError(`非法引用：${ref}`)
    const f = await this.indexFiles(ref)
    await this.sh(`rm -f -- ${sq(f.index)} ${sq(f.baseFile)} ${sq(`${f.index}.replay`)}`)
  }

  /**
   * 提交分支上的改动：write-tree → commit-tree（父提交 = 分支最新提交）→ update-ref（带旧值，防并发覆盖）。
   * 若编辑期间分支已被别人前进：把改过的文件重放到新提交上；同一文件两边都改过则拒绝（不做自动合并）。
   */
  async branchCommit(ref: string, message: string): Promise<string> {
    const text = message.trim()
    if (text === '') throw new GitError('提交说明不能为空')
    const info = await this.requireIndexMode(ref)
    const { index, base } = await this.pendingState(ref)
    if (index === null || base === null) throw new GitError('该分支没有未提交的改动')
    const changes = parseNameStatus(await this.runOk(`diff-index --cached -z -M --name-status ${base}`, { index }))
    if (changes.length === 0) throw new GitError('该分支没有未提交的改动')

    let tree: string
    if (base === info.tip) {
      tree = (await this.runOk('write-tree', { index })).trim()
    } else {
      const touched = new Set(changes.flatMap((c) => (c.origPath === undefined ? [c.path] : [c.path, c.origPath])))
      const upstream = (await this.runOk(`diff --name-only -z ${base} ${info.tip}`)).split('\0').filter(Boolean)
      const clash = upstream.filter((p) => touched.has(p))
      if (clash.length > 0) {
        throw new GitError(`编辑期间该分支已有新提交，且同样改动了：${clash.slice(0, 5).join('、')}。请撤销这些文件的改动后重新编辑。`)
      }
      const replay = `${index}.replay`
      await this.runOk(`read-tree ${info.tip}`, { index: replay })
      for (const p of touched) {
        const entry = (await this.runOk(`ls-files -s -z -- ${sq(p)}`, { index })).split(/\s/)
        const [mode, blob] = entry
        if (mode !== undefined && blob !== undefined && /^[0-9a-f]{40,64}$/.test(blob)) {
          await this.runOk(`update-index --add --cacheinfo ${mode} ${blob} ${sq(p)}`, { index: replay })
        } else {
          await this.runOk(`update-index --force-remove -- ${sq(p)}`, { index: replay })
        }
      }
      tree = (await this.runOk('write-tree', { index: replay })).trim()
    }
    const commit = (await this.runOk(`commit-tree ${tree} -p ${info.tip} -F -`, { input: text })).trim()
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError('生成提交失败')
    // 带旧值更新：这一瞬间分支若被别人改了，git 拒绝更新，不会覆盖别人的提交。
    await this.runOk(`update-ref -m ${sq(`dsh-workspace: ${text.split('\n')[0]}`)} ${sq(ref)} ${commit} ${info.tip}`)
    await this.branchDiscard(ref)
    return commit.slice(0, 12)
  }

  /** 基于某个引用新建本地分支（只建引用，不检出）。 */
  async createBranch(name: string, from: string): Promise<string> {
    const branch = name.trim()
    if (branch === '' || branch.startsWith('-')) throw new GitError(`非法分支名：${name}`)
    const valid = await this.run(`check-ref-format --branch ${sq(branch)}`)
    if (valid.code !== 0) throw new GitError(`非法分支名：${branch}`)
    const hash = await this.resolve(from)
    const ref = `refs/heads/${branch}`
    // 旧值为空：分支已存在时 git 拒绝，不会覆盖。
    const r = await this.run(`update-ref ${sq(ref)} ${hash} ''`)
    if (r.code !== 0) throw new GitError(/exists|already/i.test(r.stderr) ? `分支已存在：${branch}` : r.stderr.trim())
    return ref
  }

  /** 两个引用之间有差异的文件（直接比较两端快照）。返回解析后的提交号，diff 用 commit 目标即可。 */
  async compare(base: string, target: string): Promise<{ base: string; target: string; files: GitChangedFile[] }> {
    const b = await this.resolve(base)
    const t = await this.resolve(target)
    return { base: b, target: t, files: parseNameStatus(await this.runOk(`diff -z -M --name-status ${b} ${t}`)) }
  }
}

function sideOf(raw: string, truncated: boolean): { text: string; binary: boolean; tooLarge: boolean } {
  if (truncated) return { text: '', binary: false, tooLarge: true }
  if (raw.includes('\0')) return { text: '', binary: true, tooLarge: false }
  return { text: raw, binary: false, tooLarge: false }
}
