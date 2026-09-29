/*
 * @Description: 远程 Git 真机测试 —— 在 mktemp 出来的临时仓库里跑全部操作
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/git/git.integration.test.ts
 *
 * 运行：DSHWS_IT=1 DSHWS_DIRECT=host:port:user:password npx vitest run src/git/git.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime, DEFAULT_CONFIG, type WorkspaceRuntime } from '../runtime.js'
import { execCapture } from '../sftp/exec.js'
import { sq } from '../agent/backend.js'
import { RemoteGit, type GitStatus } from './remote-git.js'
import { layoutGraph } from './graph.js'

const enabled = process.env.DSHWS_IT === '1' && (process.env.DSHWS_DIRECT ?? '') !== ''
const TMP_PATTERN = /^\/tmp\/dshws-it\.[A-Za-z0-9]+$/

describe.runIf(enabled)('远程 Git 真机', () => {
  let sandbox: string
  let rt: WorkspaceRuntime
  let hostId: string
  let root: string
  let git: RemoteGit
  const sh = async (cmd: string): Promise<string> => {
    const c = await rt.pool.acquire(hostId, 'file', () => rt.resolveHost(hostId))
    const r = await execCapture(c, cmd, { timeoutMs: 30_000, maxBytes: 1 << 20 })
    if (r.code !== 0) throw new Error(`${cmd}\n${r.stderr}`)
    return r.stdout
  }

  beforeAll(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-git-'))
    process.env.DSH_HOME = sandbox
    rt = createRuntime(DEFAULT_CONFIG, { persistTerminals: false })
    const [host, port, user, ...rest] = (process.env.DSHWS_DIRECT as string).split(':')
    rt.vault.initialize('it-master')
    hostId = rt.vault.createHost({ label: 'it', hostname: host as string, port: Number(port), username: user as string, groupPath: '', jumpHostIds: [], auth: { kind: 'password', password: rest.join(':') } }).id
    root = (await sh('mktemp -d /tmp/dshws-it.XXXXXX')).trim()
    expect(root).toMatch(TMP_PATTERN)
    // 夹具：main 两个提交 → feature 分支一个提交 → main 一个提交 → 合并 feature（产生分叉 + 合并）
    await sh(
      [
        `cd ${sq(root)}`,
        'git init -q -b main 2>/dev/null || (git init -q && git checkout -q -b main)',
        'git config user.name it && git config user.email it@example.com',
        'printf "a\\n" > a.txt && git add a.txt && git commit -q -m "初始提交"',
        'printf "a\\nb\\n" > a.txt && git commit -q -am "second"',
        'git checkout -q -b feature && printf "f\\n" > "中文 文件.md" && git add . && git commit -q -m "功能分支"',
        'git checkout -q main && printf "c\\n" > c.txt && git add c.txt && git commit -q -m "main work"',
        'git merge -q --no-edit feature'
      ].join(' && ')
    )
    git = new RemoteGit(rt, hostId, root)
  }, 60_000)

  afterAll(async () => {
    if (TMP_PATTERN.test(root)) await sh(`rm -rf -- ${sq(root)}`)
    rt.dispose()
    delete process.env.DSH_HOME
    rmSync(sandbox, { recursive: true, force: true })
  }, 60_000)

  it('log：拓扑序、合并提交有两个父提交；分叉图出现第二条泳道', async () => {
    const commits = await git.log(0, 50)
    expect(commits).toHaveLength(5)
    expect(commits[0]?.parents).toHaveLength(2)
    expect(commits[0]?.refs.some((r) => r.includes('main'))).toBe(true)
    expect(commits.map((c) => c.subject)).toContain('功能分支')
    const rows = layoutGraph(commits)
    expect(Math.max(...rows.map((r) => r.col))).toBe(1)
  })

  it('branches：本地 main（当前）与 feature', async () => {
    const b = await git.branches()
    expect(b.find((x) => x.name === 'main')?.head).toBe(true)
    expect(b.some((x) => x.name === 'feature' && !x.remote)).toBe(true)
  })

  it('show + diff(commit)：合并提交相对第一个父提交；中文文件名', async () => {
    const [merge] = await git.log(0, 1)
    const files = await git.show(merge!.hash, merge!.parents[0]!)
    expect(files).toEqual([{ status: 'A', path: '中文 文件.md' }])
    const d = await git.diff({ kind: 'commit', hash: merge!.hash, parent: merge!.parents[0]!, path: '中文 文件.md' })
    expect(d).toEqual({ original: '', modified: 'f\n', binary: false, tooLarge: false })
    // 根提交
    const all = await git.log(0, 50)
    const rootCommit = all.find((c) => c.parents.length === 0)!
    expect(await git.show(rootCommit.hash, null)).toEqual([{ status: 'A', path: 'a.txt' }])
  })

  it('status → 暂存 → staged diff → 取消暂存 → 丢弃（含未跟踪）', async () => {
    await sh(`cd ${sq(root)} && printf "a\\nb\\nx\\n" > a.txt && printf "new\\n" > "新 文件.txt"`)
    let s = (await git.status()) as GitStatus
    expect(s.isRepo).toBe(true)
    expect(s.branch).toBe('main')
    expect(s.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'a.txt', index: '.', worktree: 'M' }),
        expect.objectContaining({ path: '新 文件.txt', kind: 'untracked' })
      ])
    )
    const wt = await git.diff({ kind: 'worktree', path: 'a.txt' })
    expect(wt).toMatchObject({ original: 'a\nb\n', modified: 'a\nb\nx\n' })

    await git.stage(['a.txt'])
    s = (await git.status()) as GitStatus
    expect(s.files.find((f) => f.path === 'a.txt')).toMatchObject({ index: 'M', worktree: '.' })
    expect(await git.diff({ kind: 'staged', path: 'a.txt' })).toMatchObject({ original: 'a\nb\n', modified: 'a\nb\nx\n' })

    await git.unstage(['a.txt'])
    s = (await git.status()) as GitStatus
    expect(s.files.find((f) => f.path === 'a.txt')).toMatchObject({ index: '.', worktree: 'M' })

    await git.discard(['a.txt'], ['新 文件.txt'])
    s = (await git.status()) as GitStatus
    expect(s.files).toEqual([])
  })

  it('提交', async () => {
    await sh(`cd ${sq(root)} && printf "z\\n" > z.txt`)
    await git.stage(['z.txt'])
    const hash = await git.commit('面板提交')
    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('【只读查看】查看 feature 分支的文件树、文件、历史、与当前分支比较 —— HEAD / 暂存区 / 工作区全程不变', async () => {
    // 查看前留一处未暂存改动 + 一处已暂存改动，查看后逐一核对。
    await sh(`cd ${sq(root)} && printf "dirty\\n" >> a.txt && printf "s\\n" > staged.txt && git add staged.txt`)
    const snapshot = async (): Promise<string> =>
      sh(`cd ${sq(root)} && git rev-parse HEAD && git symbolic-ref HEAD && git status --porcelain=v1 && md5sum a.txt staged.txt && ls`)
    const before = await snapshot()

    const tree = await git.tree('refs/heads/feature', '')
    expect(tree.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['a.txt', '中文 文件.md']))
    expect(tree.entries.map((e) => e.name)).not.toContain('c.txt') // c.txt 只在 main
    const file = await git.file('refs/heads/feature', '中文 文件.md')
    expect(file.text).toBe('f\n')
    const log = await git.log(0, 50, 'refs/heads/feature')
    expect(log.map((c) => c.subject)).toEqual(['功能分支', 'second', '初始提交'])
    const cmp = await git.compare('HEAD', 'refs/heads/feature')
    expect(cmp.files.map((f) => f.path).sort()).toEqual(['c.txt', 'z.txt'])
    const d = await git.diff({ kind: 'commit', hash: cmp.target, parent: cmp.base, path: 'c.txt' })
    expect(d).toMatchObject({ original: 'c\n', modified: '' })

    expect(await snapshot()).toBe(before)
    // 收尾：撤掉为本测试制造的改动
    await sh(`cd ${sq(root)} && git reset -q -- staged.txt && rm -f staged.txt && git checkout -- a.txt`)
  })

  it('【编辑分支】判断编辑方式：当前分支 worktree、其他本地分支 index、远程 / 标签只读', async () => {
    expect((await git.branchInfo('refs/heads/main')).mode).toBe('worktree')
    expect((await git.branchInfo('refs/heads/feature')).mode).toBe('index')
    await sh(`cd ${sq(root)} && git tag v1`)
    expect(await git.branchInfo('refs/tags/v1')).toMatchObject({ mode: 'readonly', reason: 'tag' })
  })

  it('【编辑分支】在非检出分支上改 / 新增 / 撤销 / 提交 —— 工作目录、HEAD、真正的暂存区全程不变', async () => {
    await sh(`cd ${sq(root)} && printf "dirty\\n" >> a.txt && printf "s\\n" > staged.txt && git add staged.txt`)
    const snapshot = async (): Promise<string> =>
      sh(`cd ${sq(root)} && git rev-parse HEAD && git symbolic-ref HEAD && git status --porcelain=v1 && md5sum a.txt staged.txt && git ls-files -s | md5sum && ls`)
    const before = await snapshot()
    const ref = 'refs/heads/feature'
    const tipBefore = (await git.branchInfo(ref)).tip

    await git.branchSave(ref, 'a.txt', 'a\nb\nfeature edit\n')
    await git.branchSave(ref, 'docs/新文件.md', '# 新\n')
    await git.branchSave(ref, 'c-tmp.txt', 'will revert\n')
    let changes = await git.branchChanges(ref)
    expect(changes.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A c-tmp.txt', 'A docs/新文件.md', 'M a.txt'])
    // 未提交时：分支上看到的是新内容，文件树里出现新文件
    expect((await git.file(ref, 'a.txt')).text).toBe('a\nb\nfeature edit\n')
    expect((await git.tree(ref, '')).entries.map((e) => e.name)).toContain('docs')
    expect(await git.diff({ kind: 'branch', ref, path: 'a.txt' })).toMatchObject({ original: 'a\nb\n', modified: 'a\nb\nfeature edit\n' })
    expect((await git.branchInfo(ref)).tip).toBe(tipBefore) // 还没提交，分支没动

    await git.branchRevert(ref, ['c-tmp.txt'])
    changes = await git.branchChanges(ref)
    expect(changes.files.map((f) => f.path).sort()).toEqual(['a.txt', 'docs/新文件.md'])

    const short = await git.branchCommit(ref, '在分支上直接编辑')
    const info = await git.branchInfo(ref)
    expect(info.tip.startsWith(short)).toBe(true)
    expect(info.pending).toBe(0)
    const top = (await git.log(0, 1, ref))[0]!
    expect(top.subject).toBe('在分支上直接编辑')
    expect(top.parents).toEqual([tipBefore])
    expect(await git.show(top.hash, tipBefore)).toEqual(
      expect.arrayContaining([{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'docs/新文件.md' }])
    )

    expect(await snapshot()).toBe(before)
    await sh(`cd ${sq(root)} && git reset -q -- staged.txt && rm -f staged.txt && git checkout -- a.txt`)
  })

  it('【编辑分支】编辑期间分支被别人前进：不冲突的改动重放到新提交上；同一文件两边都改则拒绝', async () => {
    const ref = 'refs/heads/feature'
    await git.branchSave(ref, 'only-mine.txt', 'mine\n')
    await git.branchSave(ref, 'a.txt', 'mine version\n')
    // 别人往 feature 提交了一个只改 other.txt 的提交（用临时 worktree 之外的底层命令模拟）
    await sh(
      `cd ${sq(root)} && T=$(git rev-parse refs/heads/feature) && B=$(printf "o\\n" | git hash-object -w --stdin) && ` +
        `GIT_INDEX_FILE=/tmp/dshws-it-idx.$$ git read-tree $T && GIT_INDEX_FILE=/tmp/dshws-it-idx.$$ git update-index --add --cacheinfo 100644 $B other.txt && ` +
        `TREE=$(GIT_INDEX_FILE=/tmp/dshws-it-idx.$$ git write-tree) && C=$(git commit-tree $TREE -p $T -m other) && git update-ref refs/heads/feature $C $T && rm -f /tmp/dshws-it-idx.$$`
    )
    await git.branchCommit(ref, '重放提交')
    const tree = (await git.tree(ref, '')).entries.map((e) => e.name)
    expect(tree).toEqual(expect.arrayContaining(['only-mine.txt', 'other.txt']))
    expect((await git.file(ref, 'a.txt')).text).toBe('mine version\n')

    // 冲突：两边都改 a.txt
    await git.branchSave(ref, 'a.txt', 'mine again\n')
    await sh(
      `cd ${sq(root)} && T=$(git rev-parse refs/heads/feature) && B=$(printf "theirs\\n" | git hash-object -w --stdin) && ` +
        `GIT_INDEX_FILE=/tmp/dshws-it-idx.$$ git read-tree $T && GIT_INDEX_FILE=/tmp/dshws-it-idx.$$ git update-index --cacheinfo 100644 $B a.txt && ` +
        `TREE=$(GIT_INDEX_FILE=/tmp/dshws-it-idx.$$ git write-tree) && C=$(git commit-tree $TREE -p $T -m theirs) && git update-ref refs/heads/feature $C $T && rm -f /tmp/dshws-it-idx.$$`
    )
    await expect(git.branchCommit(ref, 'x')).rejects.toThrow(/a\.txt/)
    await git.branchDiscard(ref)
    expect((await git.branchChanges(ref)).files).toEqual([])
    expect((await git.file(ref, 'a.txt')).text).toBe('theirs\n')
  })

  it('【编辑分支】当前分支 / 标签不能走临时索引；基于标签新建本地分支后可编辑', async () => {
    await expect(git.branchSave('refs/heads/main', 'a.txt', 'x')).rejects.toThrow(/当前检出/)
    await expect(git.branchSave('refs/tags/v1', 'a.txt', 'x')).rejects.toThrow(/新建本地分支/)
    const ref = await git.createBranch('from-tag', 'refs/tags/v1')
    expect((await git.branchInfo(ref)).mode).toBe('index')
    await expect(git.createBranch('from-tag', 'refs/tags/v1')).rejects.toThrow(/已存在/)
    await expect(git.createBranch('bad name', 'refs/tags/v1')).rejects.toThrow(/非法分支名/)
  })

  it('【另一个工作目录】分支检出在 git worktree 里：判定为在那个目录编辑，可暂存提交；主目录不变；非本仓库目录被拒', async () => {
    // 工作目录放在测试目录内（.wt 加入 exclude，不影响主目录的 status）
    await sh(`cd ${sq(root)} && echo .wt >> .git/info/exclude && git branch wt-branch && git worktree add -q .wt/wtb wt-branch`)
    const wtPath = `${root}/.wt/wtb`
    const snapshot = async (): Promise<string> =>
      sh(`cd ${sq(root)} && git rev-parse HEAD && git symbolic-ref HEAD && git status --porcelain=v1 && git ls-files -s | md5sum && ls`)
    const before = await snapshot()

    const info = await git.branchInfo('refs/heads/wt-branch')
    expect(info).toMatchObject({ mode: 'worktree', worktreePath: wtPath })
    expect(await git.isOwnWorktree(wtPath)).toBe(true)
    expect(await git.isOwnWorktree('/tmp')).toBe(false)
    expect(await git.isOwnWorktree(`${root}/.wt`)).toBe(false)
    // 预览路由据此允许预览那个工作目录里的 HTML / Markdown
    expect(await git.worktreeRoots()).toEqual(expect.arrayContaining([root, wtPath]))
    // 不走临时索引
    await expect(git.branchSave('refs/heads/wt-branch', 'a.txt', 'x')).rejects.toThrow()

    const wt = new RemoteGit(rt, hostId, wtPath)
    await sh(`cd ${sq(wtPath)} && printf "in worktree\\n" > wt-file.txt`)
    const s = (await wt.status()) as GitStatus
    expect(s.branch).toBe('wt-branch')
    expect(s.files).toEqual([expect.objectContaining({ path: 'wt-file.txt', kind: 'untracked' })])
    await wt.stage(['wt-file.txt'])
    await wt.commit('在工作目录里提交')
    expect((await git.log(0, 1, 'refs/heads/wt-branch'))[0]?.subject).toBe('在工作目录里提交')
    expect(((await wt.status()) as GitStatus).files).toEqual([])

    expect(await snapshot()).toBe(before)
  })

  it('【安全】只接受完整引用名；表达式 / 不存在的分支被拒', async () => {
    await expect(git.tree('HEAD~1', '')).rejects.toThrow(/非法引用/)
    await expect(git.tree('main', '')).rejects.toThrow(/非法引用/)
    await expect(git.file('refs/heads/feature', '../../etc/passwd')).rejects.toThrow(/非法路径/)
    await expect(git.tree('refs/heads/no-such', '')).rejects.toThrow(/找不到/)
  })

  it('【安全】仓库外路径被拒；非仓库目录如实报告', async () => {
    await expect(git.diff({ kind: 'worktree', path: '../../etc/passwd' })).rejects.toThrow(/非法路径/)
    await expect(git.stage(['/etc/passwd'])).rejects.toThrow(/非法路径/)
    const plain = new RemoteGit(rt, hostId, '/tmp')
    expect(await plain.status()).toMatchObject({ isRepo: false })
  })
})
