/*
 * @Description: 本会话默认查看分支的读写测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/git-default.test.ts
 */
import { describe, expect, it } from 'vitest'
import { getDefaultRef, setDefaultRef } from './git-default.js'

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

describe('本会话默认查看分支', () => {
  it('按会话隔离：设置 / 读取 / 清除', () => {
    const kv = memory()
    expect(getDefaultRef('s1', kv)).toBeNull()
    setDefaultRef('s1', 'refs/heads/feature/x', kv)
    setDefaultRef('s2', 'refs/remotes/origin/main', kv)
    expect(getDefaultRef('s1', kv)).toBe('refs/heads/feature/x')
    expect(getDefaultRef('s2', kv)).toBe('refs/remotes/origin/main')
    setDefaultRef('s1', null, kv)
    expect(getDefaultRef('s1', kv)).toBeNull()
    expect(getDefaultRef('s2', kv)).toBe('refs/remotes/origin/main')
  })

  it('存储里被改坏的值不采用（只接受完整引用名）', () => {
    const kv = memory()
    kv.setItem('dshws.git.defaultRef.s1', 'main;rm -rf /')
    expect(getDefaultRef('s1', kv)).toBeNull()
  })

  it('没有可用的存储时不报错', () => {
    expect(() => setDefaultRef('s1', 'refs/heads/x', undefined)).not.toThrow()
    expect(getDefaultRef('s1', undefined)).toBeNull()
  })
})
