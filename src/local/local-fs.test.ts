/*
 * @Description: 本地工作区文件操作与本地 git：路径形式互转、根目录约束、读写 / 冲突 / 改名 / 复制 / 删除、git 基本流程
 * @Author: YangHeng
 * @Date: 2026-09-30 16:30:00
 * @FilePath: /dsh-workspace/src/local/local-fs.test.ts
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ConnectionLog } from '../log/connection-log.js'
import { LocalFs, fromLocalPosix, isInside, toLocalPosix } from './local-fs.js'
import { LocalGit } from './local-git.js'

function workspace(): { root: string; fs: LocalFs; id: string; lp: (rel?: string) => string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dshws-local-')))
  const fs = new LocalFs(async () => ({ root, extraRoots: async () => [] }), new ConnectionLog(50))
  const lp = (rel = ''): string => toLocalPosix(rel === '' ? root : path.join(root, rel))
  return { root, fs, id: 'local:s1', lp }
}

describe('路径形式', () => {
  it('Windows 盘符路径 ↔ 本地 POSIX 形式', () => {
    expect(toLocalPosix('C:\\proj\\a.ts', 'win32')).toBe('/C:/proj/a.ts')
    expect(fromLocalPosix('/C:/proj/../x/a.ts', 'win32')).toBe('C:\\x\\a.ts')
    expect(fromLocalPosix('/C:', 'win32')).toBe('C:\\')
    expect(() => fromLocalPosix('/etc/passwd', 'win32')).toThrow(/不是本机路径/)
    expect(toLocalPosix('/home/me/p', 'linux')).toBe('/home/me/p')
    expect(fromLocalPosix('/home/me/../p', 'linux')).toBe('/home/p')
  })

  it('isInside：同名前缀不算在内', () => {
    expect(isInside(path.resolve('/a/b'), path.resolve('/a/b/c'))).toBe(true)
    expect(isInside(path.resolve('/a/b'), path.resolve('/a/bc'))).toBe(false)
    expect(isInside(path.resolve('/a/b'), path.resolve('/a/b'))).toBe(true)
  })
})

describe('LocalFs', () => {
  it('列目录（目录在前）、读写、冲突检测', async () => {
    const { fs, id, lp } = workspace()
    await fs.mkdir(id, lp(), 'src')
    await fs.createFile(id, lp(), 'b.txt')
    const listed = await fs.list(id, lp())
    expect(listed.entries.map((e) => [e.name, e.type])).toEqual([['src', 'dir'], ['b.txt', 'file']])
    expect(listed.entries[1]?.path).toBe(lp('b.txt'))

    const saved = await fs.writeText(id, lp('b.txt'), '你好', undefined)
    const read = await fs.readText(id, lp('b.txt'), 1024)
    expect(read).toMatchObject({ content: '你好', binary: false, lossy: false, mtime: saved.mtime })
    await expect(fs.writeText(id, lp('b.txt'), 'x', saved.mtime - 5000)).rejects.toThrow(/已被修改/)
  })

  it('拒绝工作区之外的路径与经符号链接逃逸', async () => {
    const { fs, id, root, lp } = workspace()
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'dshws-outside-')))
    writeFileSync(path.join(outside, 'secret.txt'), 's')
    await expect(fs.readText(id, toLocalPosix(path.join(outside, 'secret.txt')), 1024)).rejects.toThrow(/不在当前工作区内/)
    await expect(fs.list(id, `${lp()}/../`)).rejects.toThrow(/不在当前工作区内/)
    // Windows 目录联接不需要管理员权限
    symlinkSync(outside, path.join(root, 'link'), 'junction')
    await expect(fs.readText(id, lp('link/secret.txt'), 1024)).rejects.toThrow(/符号链接/)
    // 链接本身可以删（只删链接，不动目标）
    await fs.remove(id, lp('link'))
    expect(existsSync(path.join(outside, 'secret.txt'))).toBe(true)
  })

  it('改名防覆盖、复制自动取名、不能删根目录', async () => {
    const { fs, id, lp } = workspace()
    await fs.createFile(id, lp(), 'a.txt')
    await fs.createFile(id, lp(), 'b.txt')
    await expect(fs.rename(id, lp('a.txt'), 'b.txt')).rejects.toThrow(/已存在/)
    expect(await fs.rename(id, lp('a.txt'), 'c.txt')).toBe(lp('c.txt'))
    await fs.mkdir(id, lp(), 'dir')
    expect(await fs.copy(id, lp('c.txt'), lp())).toBe(lp('c copy.txt'))
    expect(await fs.copy(id, lp('c.txt'), lp('dir'))).toBe(lp('dir/c.txt'))
    await expect(fs.copy(id, lp('dir'), lp('dir'))).rejects.toThrow(/自己里面/)
    await expect(fs.remove(id, lp())).rejects.toThrow(/根目录/)
    expect(await fs.remove(id, lp('dir'))).toEqual({ files: 1, dirs: 1 })
  })

  it('按文件名搜索并跳过忽略目录', async () => {
    const { fs, id, root, lp } = workspace()
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '')
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'src', 'index.ts'), '')
    const r = await fs.search(id, lp(), 'index')
    expect(r.matches).toEqual([{ path: lp('src/index.ts'), type: 'file' }])
  })
})

let hasGit = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  hasGit = false
}

describe.skipIf(!hasGit)('LocalGit', () => {
  it('状态、暂存、提交、当前分支信息', async () => {
    const { root } = workspace()
    const g = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    writeFileSync(path.join(root, '中文.txt'), 'x')
    const git = new LocalGit(root)
    const status = await git.status()
    expect(status).toMatchObject({ isRepo: true, branch: 'main' })
    expect((status as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(['中文.txt'])
    await git.stage(['中文.txt'])
    const hash = await git.commit('first "quoted" message')
    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    expect((await git.log(0, 10))[0]?.subject).toBe('first "quoted" message')
    const info = await git.branchInfo('refs/heads/main')
    expect(info.mode).toBe('worktree')
    // 新建分支并在临时索引里编辑、提交（不碰工作目录）
    await git.createBranch('feature', 'refs/heads/main')
    await git.branchSave('refs/heads/feature', 'new.txt', 'hello')
    expect((await git.branchChanges('refs/heads/feature')).files.map((f) => f.path)).toEqual(['new.txt'])
    await git.branchCommit('refs/heads/feature', 'add new')
    expect(existsSync(path.join(root, 'new.txt'))).toBe(false)
    expect((await git.file('refs/heads/feature', 'new.txt')).text).toBe('hello')
  })

  it('不是仓库时给出说明', async () => {
    const { root } = workspace()
    expect(await new LocalGit(root).status()).toMatchObject({ isRepo: false })
  })
})
