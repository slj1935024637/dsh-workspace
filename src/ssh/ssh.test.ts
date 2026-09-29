/*
 * @Description: TOFU 指纹校验与连接池生命周期测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/ssh.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HostKeyChangedError, KnownHosts, fingerprintOf } from './hostkey.js'
import { SshPool } from './pool.js'
import { ConnectionLog } from '../log/connection-log.js'
import type { ResolvedTarget } from '../types.js'

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-ssh-'))
  process.env.DSH_HOME = sandbox
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

describe('TOFU 指纹校验', () => {
  it('首次连接记录指纹', () => {
    const known = new KnownHosts()
    expect(known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))).toBe('recorded')
  })

  it('指纹一致时放行', () => {
    const known = new KnownHosts()
    known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))
    expect(known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))).toBe('trusted')
  })

  it('指纹变更必须拒绝 —— 不做校验等于中间人裸奔', () => {
    const known = new KnownHosts()
    known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))
    expect(() => known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-b'))).toThrow(
      HostKeyChangedError
    )
  })

  it('不同端口视为不同端点', () => {
    const known = new KnownHosts()
    known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))
    expect(known.verify('10.0.0.1', 2222, 'ssh-rsa', Buffer.from('key-b'))).toBe('recorded')
  })

  it('用户显式信任后可覆盖旧指纹', () => {
    const known = new KnownHosts()
    known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))
    known.trust('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-b'))
    expect(known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-b'))).toBe('trusted')
  })

  it('指纹跨实例持久化', () => {
    new KnownHosts().verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))
    expect(new KnownHosts().verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))).toBe('trusted')
  })

  it('指纹格式与 OpenSSH 一致（SHA256 base64 无填充）', () => {
    const fp = fingerprintOf(Buffer.from('key-a'))
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(fp.endsWith('=')).toBe(false)
  })

  it('变更错误里同时带上新旧指纹，便于人工核对', () => {
    const known = new KnownHosts()
    known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-a'))
    try {
      known.verify('10.0.0.1', 22, 'ssh-rsa', Buffer.from('key-b'))
      expect.unreachable('应当抛出 HostKeyChangedError')
    } catch (error) {
      const err = error as HostKeyChangedError
      expect(err.expected).toBe(fingerprintOf(Buffer.from('key-a')))
      expect(err.actual).toBe(fingerprintOf(Buffer.from('key-b')))
    }
  })
})

describe('连接池', () => {
  /** ssh2 未安装或连接失败时，池必须给出错误而不是挂死。 */
  it('连接失败时进入 error 状态并保留原因', async () => {
    const log = new ConnectionLog()
    const pool = new SshPool(new KnownHosts(), log, {
      maxReconnectAttempts: 2,
      reconnectBaseDelayMs: 1
    })
    const resolve = vi.fn<() => ResolvedTarget>(() => {
      throw new Error('boom')
    })

    await expect(pool.acquire('h1', 'terminal', resolve)).rejects.toThrow('boom')
    expect(pool.statusOf('h1', 'terminal').phase).toBe('error')
    expect(pool.statusOf('h1', 'terminal').lastError).toContain('boom')
    pool.dispose()
  })

  it('失败后按配置次数重试', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 3,
      reconnectBaseDelayMs: 1
    })
    const resolve = vi.fn<() => ResolvedTarget>(() => {
      throw new Error('nope')
    })
    await expect(pool.acquire('h1', 'terminal', resolve)).rejects.toThrow()
    expect(resolve).toHaveBeenCalledTimes(3)
    pool.dispose()
  })

  it('认证失败不重试 —— 连续失败可能触发服务端 fail2ban 封禁 IP', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 1
    })
    const resolve = vi.fn<() => ResolvedTarget>(() => {
      // ssh2 认证失败时的错误形态
      throw Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication'
      })
    })
    await expect(pool.acquire('h1', 'terminal', resolve)).rejects.toThrow(/authentication/)
    expect(resolve).toHaveBeenCalledTimes(1)
    pool.dispose()
  })

  it('指纹变更不重试', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 1
    })
    const resolve = vi.fn<() => ResolvedTarget>(() => {
      throw new HostKeyChangedError('h:22', 'SHA256:a', 'SHA256:b')
    })
    await expect(pool.acquire('h1', 'terminal', resolve)).rejects.toBeInstanceOf(HostKeyChangedError)
    expect(resolve).toHaveBeenCalledTimes(1)
    pool.dispose()
  })

  it('调用方声明不可重试的错误（如保险箱锁定）立即失败', async () => {
    class Locked extends Error {}
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 1,
      isRetryable: (error) => !(error instanceof Locked)
    })
    const resolve = vi.fn<() => ResolvedTarget>(() => {
      throw new Locked('vault locked')
    })
    await expect(pool.acquire('h1', 'terminal', resolve)).rejects.toThrow('vault locked')
    expect(resolve).toHaveBeenCalledTimes(1)
    pool.dispose()
  })

  it('并发 acquire 合并为一次连接尝试', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 1,
      reconnectBaseDelayMs: 1
    })
    let calls = 0
    const resolve = (): ResolvedTarget => {
      calls += 1
      throw new Error('fail')
    }
    const results = await Promise.allSettled([
      pool.acquire('h1', 'terminal', resolve),
      pool.acquire('h1', 'terminal', resolve),
      pool.acquire('h1', 'terminal', resolve)
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    // 三次并发只应触发一次真实拨号。
    expect(calls).toBe(1)
    pool.dispose()
  })

  it('终端池与文件池互不影响', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 1,
      reconnectBaseDelayMs: 1
    })
    const resolve = (): ResolvedTarget => {
      throw new Error('fail')
    }
    await expect(pool.acquire('h1', 'terminal', resolve)).rejects.toThrow()
    expect(pool.statusOf('h1', 'terminal').phase).toBe('error')
    // 文件池从未拨号，应仍是初始态。
    expect(pool.statusOf('h1', 'file').phase).toBe('idle')
    pool.dispose()
  })

  it('dispose 后拒绝新连接 —— 防止插件卸载后仍在后台拨号', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog())
    pool.dispose()
    await expect(
      pool.acquire('h1', 'terminal', () => {
        throw new Error('should not reach')
      })
    ).rejects.toThrow(/已释放/)
  })

  it('状态变化会通知订阅者', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), {
      maxReconnectAttempts: 1,
      reconnectBaseDelayMs: 1
    })
    const seen: string[] = []
    const off = pool.subscribeStatus((s) => seen.push(s.phase))
    await expect(
      pool.acquire('h1', 'terminal', () => {
        throw new Error('fail')
      })
    ).rejects.toThrow()
    expect(seen).toContain('connecting')
    expect(seen).toContain('error')
    off()
    pool.dispose()
  })
})

describe('连接日志', () => {
  it('错误必须留痕，且带上原始 message', () => {
    const log = new ConnectionLog()
    log.error('h1', 'handshake', '连接失败', new Error('ECONNREFUSED'))
    const entries = log.list('h1')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe('error')
    expect(entries[0]?.detail).toContain('ECONNREFUSED')
  })

  it('超出容量时丢弃最旧条目', () => {
    const log = new ConnectionLog(3)
    for (let i = 0; i < 5; i += 1) log.info('h1', 'exec', `msg-${i}`)
    const entries = log.list('h1')
    expect(entries).toHaveLength(3)
    expect(entries[0]?.message).toBe('msg-4')
  })

  it('可按主机过滤', () => {
    const log = new ConnectionLog()
    log.info('h1', 'exec', 'a')
    log.info('h2', 'exec', 'b')
    expect(log.list('h1')).toHaveLength(1)
    expect(log.list()).toHaveLength(2)
  })

  it('订阅者抛错不影响日志写入', () => {
    const log = new ConnectionLog()
    log.subscribe(() => {
      throw new Error('listener blew up')
    })
    expect(() => log.info('h1', 'exec', 'still recorded')).not.toThrow()
    expect(log.list('h1')).toHaveLength(1)
  })
})
