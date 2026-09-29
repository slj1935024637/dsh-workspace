/*
 * @Description: git 输出解析与分叉图布局测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/git/git.test.ts
 */
import { describe, expect, it } from 'vitest'
import { isViewableRef, parseBranches, parseLog, parseLsTree, parseNameStatus, parseStatusV2, parseWorktrees } from './parse.js'
import { graphWidth, layoutGraph } from './graph.js'

describe('parseStatusV2', () => {
  it('分支、上游、领先落后；已改 / 重命名 / 未跟踪 / 冲突；中文与空格文件名', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb src/app.js',
      '1 .M N... 100644 100644 100644 aaa bbb 中文 目录/说明.md',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.css',
      'old name.css',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked file.txt',
      ''
    ].join('\0')
    const s = parseStatusV2(out)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: null })
    expect(s.files).toEqual([
      { path: 'src/app.js', index: 'M', worktree: '.', kind: 'changed' },
      { path: '中文 目录/说明.md', index: '.', worktree: 'M', kind: 'changed' },
      { path: 'new name.css', origPath: 'old name.css', index: 'R', worktree: '.', kind: 'renamed' },
      { path: 'conflict.txt', index: 'U', worktree: 'U', kind: 'unmerged' },
      { path: 'untracked file.txt', index: '?', worktree: '?', kind: 'untracked' }
    ])
  })

  it('游离 HEAD；全新仓库（无提交）', () => {
    expect(parseStatusV2('# branch.oid 0123456789abcdef\0# branch.head (detached)\0').detached).toBe('0123456789ab')
    const fresh = parseStatusV2('# branch.oid (initial)\0# branch.head main\0')
    expect(fresh).toMatchObject({ branch: 'main', detached: null, files: [] })
  })
})

describe('parseLog / parseBranches / parseNameStatus', () => {
  it('log：父提交、装饰、带分隔字符的标题', () => {
    const out = `aaaaaaa1\x1fbbbbbbb2 ccccccc3\x1f张三\x1f1700000000\x1fHEAD -> main, origin/main, tag: v1\x1fMerge: 合并 a|b\x1e\nbbbbbbb2\x1f\x1fli\x1f1600000000\x1f\x1finit\x1e`
    const log = parseLog(out)
    expect(log[0]).toEqual({
      hash: 'aaaaaaa1',
      parents: ['bbbbbbb2', 'ccccccc3'],
      author: '张三',
      date: 1700000000000,
      refs: ['HEAD -> main', 'origin/main', 'tag: v1'],
      subject: 'Merge: 合并 a|b'
    })
    expect(log[1]?.parents).toEqual([])
  })

  it('for-each-ref：本地 / 远程、当前分支，忽略 origin/HEAD', () => {
    const out = [
      'refs/heads/main\x1fmain\x1fabc\x1forigin/main\x1f*',
      'refs/heads/dev\x1fdev\x1fdef\x1f\x1f ',
      'refs/remotes/origin/HEAD\x1forigin\x1fabc\x1f\x1f ',
      'refs/remotes/origin/main\x1forigin/main\x1fabc\x1f\x1f '
    ].join('\n')
    const b = parseBranches(out)
    expect(b.map((x) => [x.name, x.remote, x.head])).toEqual([
      ['main', false, true],
      ['dev', false, false],
      ['origin/main', true, false]
    ])
    expect(b[0]?.upstream).toBe('origin/main')
  })

  it('name-status -z：修改 / 新增 / 删除 / 重命名', () => {
    const out = ['M', 'a.js', 'A', '新 文件.md', 'D', 'gone.txt', 'R087', 'old.css', 'new.css', ''].join('\0')
    expect(parseNameStatus(out)).toEqual([
      { status: 'M', path: 'a.js' },
      { status: 'A', path: '新 文件.md' },
      { status: 'D', path: 'gone.txt' },
      { status: 'R', origPath: 'old.css', path: 'new.css' }
    ])
  })
})

describe('parseLsTree / isViewableRef', () => {
  it('目录在前、中文与空格名、子模块、大小', () => {
    const out = [
      '100644 blob aaa      12\tb.txt',
      '040000 tree bbb       -\tsrc',
      '100644 blob ccc       3\t中文 文件.md',
      '160000 commit ddd       -\tvendor'
    ].join('\0')
    const e = parseLsTree(out, 'dir')
    expect(e[0]).toEqual({ name: 'src', path: 'dir/src', type: 'tree' })
    expect(e.find((x) => x.name === '中文 文件.md')).toEqual({ name: '中文 文件.md', path: 'dir/中文 文件.md', type: 'blob', size: 3 })
    expect(e.find((x) => x.name === 'vendor')?.type).toBe('commit')
  })

  it('只接受 HEAD 与完整引用名', () => {
    for (const ok of ['HEAD', 'refs/heads/main', 'refs/remotes/origin/feat/x', 'refs/tags/v1.0']) expect(isViewableRef(ok), ok).toBe(true)
    for (const bad of ['main', 'HEAD~1', 'refs/heads/a..b', 'refs/heads/x@{1}', 'refs/heads/a b', 'refs/heads/x:y', '--output=/tmp/x', 'refs/other/x']) {
      expect(isViewableRef(bad), bad).toBe(false)
    }
  })
})

describe('parseWorktrees', () => {
  it('主工作目录 + 其他工作目录（分支 / 游离 / 已删除）', () => {
    const out = [
      'worktree /home/ps/testdsh', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /tmp/wt/light-theme', 'HEAD bbb', 'branch refs/heads/feature/light-theme', '',
      'worktree /tmp/wt/detached', 'HEAD ccc', 'detached', '',
      'worktree /tmp/wt/gone', 'HEAD ddd', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', ''
    ].join('\n')
    expect(parseWorktrees(out)).toEqual([
      { path: '/home/ps/testdsh', branch: 'refs/heads/main', prunable: false },
      { path: '/tmp/wt/light-theme', branch: 'refs/heads/feature/light-theme', prunable: false },
      { path: '/tmp/wt/detached', branch: null, prunable: false },
      { path: '/tmp/wt/gone', branch: 'refs/heads/old', prunable: true }
    ])
  })
})

describe('layoutGraph', () => {
  it('线性历史：一条泳道', () => {
    const rows = layoutGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(rows.map((r) => r.incoming)).toEqual([false, true, true])
    expect(graphWidth(rows)).toBe(1)
  })

  it('分叉 + 合并：合并提交向右分出第二条泳道，两条在共同祖先处汇合', () => {
    // m 合并 f 到 main；f 与 b 都基于 a
    const rows = layoutGraph([
      { hash: 'm', parents: ['b', 'f'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    expect(rows[0]?.col).toBe(0)
    expect(rows[0]?.edges).toContainEqual({ from: 0, to: 1, kind: 'branch-out' })
    expect(rows[1]?.col).toBe(1) // f 在第二条泳道
    expect(rows[2]?.col).toBe(0) // b 回到主泳道
    // a 处两条泳道汇合
    expect(rows[3]?.col).toBe(0)
    expect(rows[3]?.edges).toContainEqual({ from: 1, to: 0, kind: 'merge-in' })
    expect(rows[3]?.lanes).toEqual([])
    expect(graphWidth(rows)).toBe(2)
  })

  it('多个分支顶端（--all）：各占一条泳道', () => {
    const rows = layoutGraph([
      { hash: 'x', parents: ['a'] },
      { hash: 'y', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0])
    expect(rows[2]?.edges).toContainEqual({ from: 1, to: 0, kind: 'merge-in' })
  })
})
