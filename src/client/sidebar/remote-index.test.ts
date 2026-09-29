/*
 * @Description: 右侧栏远程会话判定测试 —— 地址解析、路径映射、按会话查远程工作区
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/remote-index.test.ts
 */
import { describe, expect, it } from 'vitest'
import { RemoteIndex, normalizePosix, parseFileAddress, sessionFileAddress, toRemotePath } from './remote-index.js'

const ws = {
  localPath: 'C:\\Users\\yangheng\\.dsh\\workspaces\\remote\\192.168.3.112-ps-22\\测试DSH远程',
  hostId: 'h1',
  remotePath: '/home/ps/testdsh',
  title: '测试DSH远程'
}

function indexWith(sessions: Record<string, { cwd?: string }>) {
  const index = new RemoteIndex(async () => [ws], () => ({ list: { getSnapshot: () => ({ byId: sessions }), subscribe: () => () => undefined } }))
  return index
}

describe('文件地址', () => {
  it('DSH 生成的会话地址（远程绝对路径保留前导 /，中文逐段编码）可往返', () => {
    const addr = sessionFileAddress('session-1', '/home/ps/testdsh/calculator/index.html')
    expect(addr).toBe('dsh-resource://file/session/session-1//home/ps/testdsh/calculator/index.html')
    expect(parseFileAddress(addr)).toEqual({ scope: 'session', sessionId: 'session-1', path: '/home/ps/testdsh/calculator/index.html' })
    expect(parseFileAddress(sessionFileAddress('s', '文档/说明.md'))?.path).toBe('文档/说明.md')
  })

  it('absolute 地址：盘符与 POSIX', () => {
    expect(parseFileAddress('dsh-resource://file/absolute/C:/x/y.txt')?.path).toBe('C:/x/y.txt')
    expect(parseFileAddress('dsh-resource://file/absolute/home/a')?.path).toBe('/home/a')
    expect(parseFileAddress('https://x')).toBeUndefined()
  })
})

describe('路径映射', () => {
  it('远程绝对路径原样；相对路径接到远程根；.. 折叠', () => {
    expect(toRemotePath(ws, '/home/ps/testdsh/app.js')).toBe('/home/ps/testdsh/app.js')
    expect(toRemotePath(ws, 'calculator/index.html')).toBe('/home/ps/testdsh/calculator/index.html')
    expect(toRemotePath(ws, 'a/../b')).toBe('/home/ps/testdsh/b')
    expect(normalizePosix('/a/./b/../c')).toBe('/a/c')
  })

  it('占位目录下的本机路径换成远程路径（大小写、斜杠方向不敏感）；其他本机路径不属于该工作区', () => {
    expect(toRemotePath(ws, 'c:/users/yangheng/.dsh/workspaces/remote/192.168.3.112-ps-22/测试DSH远程/x/y.ts')).toBe('/home/ps/testdsh/x/y.ts')
    expect(toRemotePath(ws, 'C:\\home\\ps\\testdsh\\app.js')).toBeUndefined()
  })
})

describe('RemoteIndex', () => {
  it('只有远程工作区的会话里的地址才被认领（这是修「点开文件读 C 盘」的判定）', async () => {
    const index = indexWith({ remote: { cwd: ws.localPath }, local: { cwd: 'C:\\DshChat' } })
    await index.refresh()
    const hit = index.resolveAddress(sessionFileAddress('remote', '/home/ps/testdsh/calculator/index.html'))
    expect(hit?.remotePath).toBe('/home/ps/testdsh/calculator/index.html')
    expect(hit?.workspace.hostId).toBe('h1')
    expect(index.resolveAddress(sessionFileAddress('local', '/home/ps/testdsh/app.js'))).toBeUndefined()
    expect(index.resolveAddress(sessionFileAddress('unknown', 'a.txt'))).toBeUndefined()
    expect(index.bySession('remote')?.title).toBe('测试DSH远程')
  })

  it('列表内容没变时不通知、沿用旧对象（否则远程 Git 面板会反复整页重载并关掉预览）', async () => {
    let list = [{ ...ws }]
    const index = new RemoteIndex(async () => list.map((w) => ({ ...w })), () => ({ list: { getSnapshot: () => ({ byId: { s: { cwd: ws.localPath } } }), subscribe: () => () => undefined } }))
    let notified = 0
    index.subscribe(() => notified++)
    await index.refresh()
    const first = index.bySession('s')
    await index.refresh()
    await index.refresh()
    expect(notified).toBe(1)
    expect(index.bySession('s')).toBe(first)
    list = [{ ...ws, title: '改名' }]
    await index.refresh()
    expect(notified).toBe(2)
    expect(index.bySession('s')?.title).toBe('改名')
  })

  it('列表未加载 / 加载失败时一律不认领（交还原处理方，而不是报错）', async () => {
    const failing = new RemoteIndex(async () => {
      throw new Error('not ready')
    }, () => undefined)
    await failing.refresh()
    expect(failing.resolveAddress(sessionFileAddress('s', '/x'))).toBeUndefined()
  })
})
