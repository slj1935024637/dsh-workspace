/*
 * @Description: 本机目录浏览（macOS native 选择器兜底）测试
 * @Author: YangHeng
 * @Date: 2026-09-30 11:30:00
 * @FilePath: /dsh-workspace/src/local/browse.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalBrowseError, listLocalDirectory, makeLocalDirectory, resolveLocalPath } from './browse.js'
import { expandHome } from '../ssh/connection.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dshws-browse-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('listLocalDirectory', () => {
  it('只列子目录、按名称排序、. 开头为隐藏', async () => {
    mkdirSync(path.join(dir, 'b'))
    mkdirSync(path.join(dir, 'A'))
    mkdirSync(path.join(dir, '.git'))
    writeFileSync(path.join(dir, 'file.txt'), 'x')
    const r = await listLocalDirectory(dir)
    expect(r.entries.map((e) => [e.name, e.hidden])).toEqual([
      ['.git', true],
      ['A', false],
      ['b', false]
    ])
    expect(r.home).toBe(os.homedir())
  })

  it('不给路径时列家目录；相对路径拒绝', async () => {
    expect((await listLocalDirectory(undefined)).path).toBe(os.homedir())
    await expect(listLocalDirectory('relative/x')).rejects.toBeInstanceOf(LocalBrowseError)
  })

  it('不存在的目录报 unreadable（不会被当成空目录）', async () => {
    await expect(listLocalDirectory(path.join(dir, 'nope'))).rejects.toMatchObject({ kind: 'unreadable' })
  })
})

describe('makeLocalDirectory', () => {
  it('新建一级目录；重名报 exists；名称带分隔符拒绝', async () => {
    const created = await makeLocalDirectory(dir, 'new')
    expect(created).toBe(path.join(dir, 'new'))
    await expect(makeLocalDirectory(dir, 'new')).rejects.toMatchObject({ kind: 'exists' })
    await expect(makeLocalDirectory(dir, 'a/b')).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('resolveLocalPath', () => {
  it('按平台判断绝对路径；Windows 裸盘符补成根', () => {
    expect(resolveLocalPath('C:', 'win32')).toBe('C:\\')
    expect(resolveLocalPath('/Users/me/../me', 'darwin')).toBe('/Users/me')
    expect(() => resolveLocalPath('C:\\x', 'linux')).toThrow(LocalBrowseError)
  })
})

describe('expandHome', () => {
  it('展开开头的 ~，其余原样', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(path.join(os.homedir(), '.ssh/id_ed25519'))
    expect(expandHome('~')).toBe(os.homedir())
    expect(expandHome('/abs/~x')).toBe('/abs/~x')
    expect(expandHome('~other/x')).toBe('~other/x')
  })
})
