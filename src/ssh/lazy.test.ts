/*
 * @Description: ssh2 延迟加载的降级行为测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/lazy.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { isSsh2Available, loadSsh2, requireSsh2, resetSsh2Cache, ssh2LoadFailure } from './lazy.js'

beforeEach(() => {
  resetSsh2Cache()
})

/** 造一个必定失败的 require，模拟原生构建被 pnpm 拦截。 */
function brokenRequire(): NodeRequire {
  const fn = (() => {
    throw new Error("Cannot find module '../build/Release/sshcrypto.node'")
  }) as unknown as NodeRequire
  return fn
}

describe('ssh2 lazy 加载', () => {
  it('真实环境下能加载到 ssh2', () => {
    const mod = loadSsh2()
    expect(mod).not.toBeNull()
    expect(typeof mod?.Client).toBe('function')
  })

  it('加载失败返回 null 而不是抛错 —— 这是不拖垮宿主启动的关键', () => {
    expect(loadSsh2(brokenRequire())).toBeNull()
    expect(isSsh2Available()).toBe(false)
  })

  it('失败原因被保留，供日志面板展示', () => {
    loadSsh2(brokenRequire())
    const failure = ssh2LoadFailure()
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('sshcrypto.node')
  })

  it('结果被缓存：一次失败后不再反复尝试', () => {
    let calls = 0
    const counting = (() => {
      calls += 1
      throw new Error('nope')
    }) as unknown as NodeRequire
    loadSsh2(counting)
    loadSsh2(counting)
    loadSsh2(counting)
    expect(calls).toBe(1)
  })

  it('requireSsh2 在失败时给出可操作的修复指引', () => {
    loadSsh2(brokenRequire())
    let message = ''
    try {
      requireSsh2(brokenRequire())
    } catch (error) {
      message = (error as Error).message
    }
    // 指引必须直接点名要改的文件和字段，否则用户只能靠猜。
    expect(message).toContain('pnpm-workspace.yaml')
    expect(message).toContain('allowBuilds')
    expect(message).toContain('ssh2: true')
    expect(message).toContain('cpu-features: true')
  })
})
