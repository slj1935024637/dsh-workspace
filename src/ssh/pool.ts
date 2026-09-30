/*
 * @Description: 连接池 —— 终端池与文件池分离，透明重连，生命周期可回收
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/pool.ts
 */
import type { ConnectionStatus, ResolvedTarget } from '../types.js'
import type { ConnectionLog } from '../log/connection-log.js'
import { SshConnection, initialStatus } from './connection.js'
import { HostKeyChangedError, KnownHosts } from './hostkey.js'

/**
 * 连接用途。
 *
 * 分池的理由：终端是人在交互，最怕卡顿；文件批量传输会把带宽吃满。
 * 共用一条连接时，一次大目录同步就会让终端明显卡顿。
 * 代价只是多一次认证握手。
 */
// agent：Agent 的 bash 命令单独一池 —— 长时间编译 / 测试不拖慢文件传输与终端。
export type ChannelKind = 'terminal' | 'file' | 'agent'

interface PoolEntry {
  connection: SshConnection | null
  /** 合并并发连接请求，避免同时打多条。 */
  pending: Promise<SshConnection> | null
  status: ConnectionStatus
  /** 代际令牌：目标变更或关闭时自增，让在途的旧连接无法回填。 */
  epoch: number
}

export interface PoolOptions {
  timeoutMs?: number
  /** 重连最大尝试次数，超过则进入 error 状态。 */
  maxReconnectAttempts?: number
  /** 重连初始退避（毫秒），按指数增长。 */
  reconnectBaseDelayMs?: number
  /**
   * 额外判定某个错误是否值得重试（返回 false 即立刻失败）。
   * 池本身已排除认证失败与指纹变更；调用方可补充自己的领域错误（如保险箱锁定）。
   */
  isRetryable?: (error: unknown) => boolean
}

/**
 * 只有「过一会儿可能自己好」的错误才值得重试：网络抖动、超时、对端暂不可达。
 *
 * 明确不重试：
 * - 主机指纹变更 —— 安全事件，重试只会反复拒绝并刷屏日志
 * - 认证失败 —— 密码错了等多久都是错的；更要紧的是许多服务器装了 fail2ban，
 *   连续几次认证失败会把用户的 IP 封掉，重试等于帮倒忙
 */
export function isTransientSshError(error: unknown): boolean {
  if (error instanceof HostKeyChangedError) return false
  if (typeof error === 'object' && error !== null) {
    // ssh2 在认证阶段失败时给 error.level = 'client-authentication'。
    if ((error as { level?: unknown }).level === 'client-authentication') return false
    if (isUnreachableError(error)) return false
  }
  return true
}

/** 「主机连不上」类的网络错误码：对端拒绝、不可达、域名解析失败、TCP 连接超时。 */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'])

/**
 * 主机连不上（而不是连上之后又断了）。这类错误不重试：
 * 原先按 5 次 × 20 秒握手超时重试，一个请求要挂约 107 秒；界面上来回切换主机时，
 * 这些挂着的请求会占满浏览器对同一地址的 6 个并发连接，连带正常主机与状态轮询全部排队卡住。
 * 连接中途断开（ECONNRESET、握手前连接丢失）仍按原策略重试 —— 那种多半是网络抖动。
 */
export function isUnreachableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { code?: unknown; level?: unknown; message?: unknown }
  if (typeof e.code === 'string' && UNREACHABLE_CODES.has(e.code)) return true
  // ssh2 的握手超时：level = 'client-timeout'（"Timed out while waiting for handshake"）。
  if (e.level === 'client-timeout') return true
  return typeof e.message === 'string' && /Timed out while waiting for handshake/i.test(e.message)
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_DELAY = 500

/**
 * 按「主机 + 用途」维度持有连接。
 *
 * 所有连接都必须能被插件卸载时统一回收，因此 dispose() 是契约的一部分，
 * 由 index.ts 挂在 ctx.effect 上。
 */
export class SshPool {
  private entries = new Map<string, PoolEntry>()
  private statusListeners = new Set<(status: ConnectionStatus) => void>()
  private disposed = false

  constructor(
    private readonly knownHosts: KnownHosts,
    private readonly log: ConnectionLog,
    private readonly options: PoolOptions = {}
  ) {}

  private keyOf(hostId: string, kind: ChannelKind): string {
    return `${kind}:${hostId}`
  }

  private entryOf(hostId: string, kind: ChannelKind): PoolEntry {
    const key = this.keyOf(hostId, kind)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = { connection: null, pending: null, status: initialStatus(hostId), epoch: 0 }
      this.entries.set(key, entry)
    }
    return entry
  }

  /**
   * 取一条可用连接；没有就建立。并发调用会合并到同一次连接尝试上。
   *
   * @param resolve 惰性求值的目标解析函数 —— 每次重连都重新解析，
   *                这样用户改了主机配置后无需手动断开重连。
   */
  async acquire(
    hostId: string,
    kind: ChannelKind,
    resolve: () => Promise<ResolvedTarget> | ResolvedTarget
  ): Promise<SshConnection> {
    if (this.disposed) throw new Error('连接池已释放。')
    const entry = this.entryOf(hostId, kind)
    if (entry.connection !== null) return entry.connection
    if (entry.pending !== null) return await entry.pending

    const epoch = entry.epoch
    const attempt = this.dialWithRetry(hostId, kind, entry, epoch, resolve)
    entry.pending = attempt
    try {
      return await attempt
    } finally {
      if (entry.pending === attempt) entry.pending = null
    }
  }

  /** 带指数退避的连接尝试。指纹变更属于安全事件，不重试。 */
  private async dialWithRetry(
    hostId: string,
    kind: ChannelKind,
    entry: PoolEntry,
    epoch: number,
    resolve: () => Promise<ResolvedTarget> | ResolvedTarget
  ): Promise<SshConnection> {
    const maxAttempts = this.options.maxReconnectAttempts ?? DEFAULT_MAX_ATTEMPTS
    const baseDelay = this.options.reconnectBaseDelayMs ?? DEFAULT_BASE_DELAY
    let lastError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.disposed || entry.epoch !== epoch) {
        throw new Error('连接已被取消（目标变更或池已释放）。')
      }
      this.setStatus(entry, {
        phase: attempt === 0 ? 'connecting' : 'reconnecting',
        ...(attempt > 0 ? { reconnectCount: entry.status.reconnectCount + 1 } : {})
      })

      const startedAt = Date.now()
      try {
        const target = await resolve()
        const connection = await SshConnection.connect(
          target,
          this.knownHosts,
          this.log,
          this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }
        )
        // 在途期间目标变了或池释放了，这条连接就是孤儿，直接关掉。
        if (this.disposed || entry.epoch !== epoch) {
          connection.close()
          throw new Error('连接已被取消（目标变更或池已释放）。')
        }
        entry.connection = connection
        this.setStatus(entry, {
          phase: 'ready',
          latencyMs: Date.now() - startedAt,
          connectedAt: new Date().toISOString(),
          lastError: undefined
        })
        this.attachDropHandler(hostId, kind, entry, epoch, connection)
        return connection
      } catch (error) {
        lastError = error
        const retryable = isTransientSshError(error) && (this.options.isRetryable?.(error) ?? true)
        if (!retryable) break
        if (attempt < maxAttempts - 1) {
          const delay = baseDelay * 2 ** attempt
          this.log.warn(
            hostId,
            'handshake',
            `连接失败，${delay}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）。`
          )
          await sleep(delay)
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    this.setStatus(entry, { phase: 'error', lastError: message })
    throw lastError instanceof Error ? lastError : new Error(message)
  }

  /** 连接意外断开时清空槽位，下次 acquire 会自动重建（懒重连）。 */
  private attachDropHandler(
    hostId: string,
    kind: ChannelKind,
    entry: PoolEntry,
    epoch: number,
    connection: SshConnection
  ): void {
    const onDrop = (reason: string) => (): void => {
      if (entry.epoch !== epoch || entry.connection !== connection) return
      entry.connection = null
      this.setStatus(entry, { phase: 'idle', lastError: reason })
      this.log.warn(hostId, 'handshake', `连接已断开（${reason}），下次使用时将自动重连。`)
    }
    const raw = connection.raw()
    raw.once('close', onDrop('close') as (...args: unknown[]) => void)
    raw.once('end', onDrop('end') as (...args: unknown[]) => void)
    void kind
  }

  /** 主动断开某主机的连接。kind 省略则断开该主机的全部用途。 */
  disconnect(hostId: string, kind?: ChannelKind): void {
    const kinds: ChannelKind[] = kind === undefined ? ['terminal', 'file'] : [kind]
    for (const k of kinds) {
      const entry = this.entries.get(this.keyOf(hostId, k))
      if (entry === undefined) continue
      entry.epoch += 1
      entry.pending = null
      if (entry.connection !== null) {
        entry.connection.close()
        entry.connection = null
      }
      this.setStatus(entry, { phase: 'idle', lastError: undefined })
    }
  }

  /** 当前状态快照，供 UI 的状态指示点使用。 */
  statusOf(hostId: string, kind: ChannelKind = 'terminal'): ConnectionStatus {
    return this.entryOf(hostId, kind).status
  }

  listStatuses(): ConnectionStatus[] {
    return [...this.entries.values()].map((entry) => entry.status)
  }

  subscribeStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  private setStatus(entry: PoolEntry, patch: Partial<ConnectionStatus>): void {
    entry.status = { ...entry.status, ...patch }
    for (const listener of this.statusListeners) {
      try {
        listener(entry.status)
      } catch {
        /* 订阅者自身的问题不应影响连接流程 */
      }
    }
  }

  /** 释放全部连接。插件卸载时由 ctx.effect 调用。 */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.epoch += 1
      entry.pending = null
      if (entry.connection !== null) {
        try {
          entry.connection.close()
        } catch {
          /* 已断开的连接重复关闭属正常 */
        }
        entry.connection = null
      }
    }
    this.entries.clear()
    this.statusListeners.clear()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export { KnownHosts }
