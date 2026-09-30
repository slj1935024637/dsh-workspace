/*
 * @Description: 跨平台小工具测试 —— Windows 改名重试、PowerShell 绝对路径、大小写敏感判定
 * @Author: YangHeng
 * @Date: 2026-09-30 11:55:00
 * @FilePath: /dsh-workspace/src/fs-atomic.test.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renameWithRetry } from './fs-atomic.js'
import { powershellPath } from './vault/auto-unlock.js'
import { caseInsensitiveFs } from './workspace/bindings.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dshws-atomic-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const busy = (code: string) => Object.assign(new Error(code), { code })

describe('renameWithRetry', () => {
  it('Windows 上被占用（EPERM）时重试，释放后成功', () => {
    let calls = 0
    renameWithRetry('a', 'b', 'win32', () => {
      calls += 1
      if (calls < 3) throw busy('EPERM')
    })
    expect(calls).toBe(3)
  })

  it('重试用尽或非 Windows：删掉临时文件并抛出原始错误', () => {
    const tmp = path.join(dir, 'x.tmp')
    writeFileSync(tmp, 'x')
    expect(() => renameWithRetry(tmp, path.join(dir, 'x'), 'linux', () => { throw busy('EPERM') })).toThrow('EPERM')
    expect(existsSync(tmp)).toBe(false)
  })

  it('不可重试的错误立即抛出', () => {
    let calls = 0
    expect(() => renameWithRetry('a', 'b', 'win32', () => { calls += 1; throw busy('ENOENT') })).toThrow('ENOENT')
    expect(calls).toBe(1)
  })
})

describe('平台判定', () => {
  it('PowerShell 用 SystemRoot 下的绝对路径，缺失时退回 PATH', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellPath({})).toBe('powershell.exe')
  })

  it('Windows / macOS 文件系统不区分大小写，Linux 区分', () => {
    expect(caseInsensitiveFs('win32')).toBe(true)
    expect(caseInsensitiveFs('darwin')).toBe(true)
    expect(caseInsensitiveFs('linux')).toBe(false)
  })
})
