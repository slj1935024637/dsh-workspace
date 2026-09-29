/*
 * @Description: SSH 连接 —— 跳板链、代理出站、TOFU 校验、透明重连
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/connection.ts
 */
import { readFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import type { ConnectionStatus, HostProxy, ResolvedTarget } from '../types.js'
import type { ConnectionLog } from '../log/connection-log.js'
import { requireSsh2 } from './lazy.js'
import { KnownHosts } from './hostkey.js'

/** ssh2 Client 的最小结构约束 —— 避免让 @types/ssh2 渗进运行时契约。 */
interface Ssh2Client {
  on(event: string, listener: (...args: unknown[]) => void): Ssh2Client
  once(event: string, listener: (...args: unknown[]) => void): Ssh2Client
  removeListener(event: string, listener: (...args: unknown[]) => void): Ssh2Client
  connect(config: Record<string, unknown>): void
  end(): void
  destroy(): void
  exec(command: string, options: unknown, callback: (err: Error | null, stream: unknown) => void): void
  shell(window: unknown, options: unknown, callback: (err: Error | null, stream: unknown) => void): void
  sftp(callback: (err: Error | null, sftp: unknown) => void): void
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | null, channel: Duplex) => void
  ): void
}

export interface ConnectOptions {
  /** 连接超时（毫秒）。 */
  timeoutMs?: number
  /** keepalive 间隔，0 表示关闭。 */
  keepaliveIntervalMs?: number
}

const DEFAULT_TIMEOUT = 20_000
const DEFAULT_KEEPALIVE = 15_000

/**
 * 一条已建立的 SSH 连接。
 *
 * 跳板链的实现方式：先连第一跳，用它的 forwardOut 打出一条到下一跳的通道，
 * 把这条通道当作下一跳的 sock 传进去，逐级套娃。最后一跳才是目标主机。
 * 这样中间跳板不需要安装任何东西，纯协议层转发。
 */
export class SshConnection {
  private constructor(
    readonly target: ResolvedTarget,
    private readonly client: Ssh2Client,
    /** 跳板链上的上游连接，按连接顺序排列；关闭时要逆序关掉。 */
    private readonly upstream: SshConnection[]
  ) {}

  /** 建立连接（含跳板链展开与 TOFU 校验）。 */
  static async connect(
    target: ResolvedTarget,
    knownHosts: KnownHosts,
    log: ConnectionLog,
    options: ConnectOptions = {}
  ): Promise<SshConnection> {
    const chain: SshConnection[] = []
    let sock: Duplex | undefined

    // 逐级建立跳板连接。任何一级失败都要把已建立的部分拆掉，避免泄漏。
    try {
      for (const hop of target.jumpChain) {
        log.info(target.hostId, 'handshake', `经由跳板机 ${hop.label}（${hop.hostname}）`)
        const hopConnection = await SshConnection.dial(hop, knownHosts, log, options, sock)
        chain.push(hopConnection)
        sock = await hopConnection.openChannelTo(target.hostname, target.port)
      }
      const client = await SshConnection.rawDial(target, knownHosts, log, options, sock)
      return new SshConnection(target, client, chain)
    } catch (error) {
      for (const hop of chain.reverse()) hop.close()
      throw error
    }
  }

  /** 建立一跳连接（不再递归展开它自己的跳板链 —— 上层已展开）。 */
  private static async dial(
    target: ResolvedTarget,
    knownHosts: KnownHosts,
    log: ConnectionLog,
    options: ConnectOptions,
    sock: Duplex | undefined
  ): Promise<SshConnection> {
    const client = await SshConnection.rawDial(target, knownHosts, log, options, sock)
    return new SshConnection(target, client, [])
  }

  private static async rawDial(
    target: ResolvedTarget,
    knownHosts: KnownHosts,
    log: ConnectionLog,
    options: ConnectOptions,
    sock: Duplex | undefined
  ): Promise<Ssh2Client> {
    const ssh2 = requireSsh2()
    const ClientCtor = ssh2.Client as new () => Ssh2Client
    const client = new ClientCtor()

    // 代理只作用于「直连」的那一跳；走跳板时链路已由上游提供。
    const socket =
      sock ?? (target.proxy !== undefined ? await openProxySocket(target.proxy, target) : undefined)

    const config: Record<string, unknown> = {
      host: target.hostname,
      port: target.port,
      username: target.username,
      readyTimeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
      keepaliveInterval: options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE,
      ...(socket !== undefined ? { sock: socket } : {}),
      // TOFU：ssh2 把指纹校验交给这个回调，返回 false 即中断握手。
      hostVerifier: (key: Buffer) => {
        try {
          const outcome = knownHosts.verify(target.hostname, target.port, 'ssh-key', key)
          if (outcome === 'recorded') {
            log.warn(
              target.hostId,
              'handshake',
              `首次连接，已记录主机指纹（TOFU）：${target.hostname}:${target.port}`
            )
          }
          return true
        } catch (error) {
          // 指纹变更必须留痕：这是安全事件，不能只体现为一次连接失败。
          log.error(target.hostId, 'handshake', '主机指纹校验失败，已拒绝连接。', error)
          return false
        }
      }
    }

    applyAuth(config, target)

    const startedAt = Date.now()
    return await new Promise<Ssh2Client>((resolve, reject) => {
      const onReady = (): void => {
        cleanup()
        log.info(
          target.hostId,
          'handshake',
          `已连接 ${target.username}@${target.hostname}:${target.port}（${Date.now() - startedAt}ms）`
        )
        resolve(client)
      }
      const onError = (error: unknown): void => {
        cleanup()
        log.error(target.hostId, 'handshake', `连接失败：${target.hostname}:${target.port}`, error)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const cleanup = (): void => {
        client.removeListener('ready', onReady as (...args: unknown[]) => void)
        client.removeListener('error', onError as (...args: unknown[]) => void)
      }
      client.once('ready', onReady as (...args: unknown[]) => void)
      client.once('error', onError as (...args: unknown[]) => void)
      client.connect(config)
    })
  }

  /** 通过本连接打一条到 host:port 的转发通道（用于跳板链的下一跳）。 */
  private openChannelTo(host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
        if (err !== null && err !== undefined) reject(err)
        else resolve(channel)
      })
    })
  }

  /** 暴露底层 client 给终端、SFTP 等消费者。 */
  raw(): Ssh2Client {
    return this.client
  }

  /** 关闭本连接及其上游跳板（逆序）。 */
  close(): void {
    try {
      this.client.end()
    } catch {
      /* 已经断开的连接重复 end 属正常 */
    }
    for (const hop of [...this.upstream].reverse()) hop.close()
  }
}

/** 把认证信息写进 ssh2 的连接配置。 */
function applyAuth(config: Record<string, unknown>, target: ResolvedTarget): void {
  const auth = target.auth
  switch (auth.kind) {
    case 'password':
      config.password = auth.password
      break
    case 'keyPath':
      // 私钥读取失败要抛在这里，比让 ssh2 报一个含糊的认证错误清楚得多。
      try {
        config.privateKey = readFileSync(auth.keyPath)
      } catch (cause) {
        throw new Error(`无法读取私钥文件：${auth.keyPath}`, { cause })
      }
      if (auth.passphrase !== undefined) config.passphrase = auth.passphrase
      break
    case 'keyContent':
      config.privateKey = auth.keyContent
      if (auth.passphrase !== undefined) config.passphrase = auth.passphrase
      break
    case 'agent':
      // ssh-agent 在 P0 范围外，但保留这条分支避免类型收窄时漏掉。
      config.agent = process.env.SSH_AUTH_SOCK
      break
  }
}

/** 通过 SOCKS5 / HTTP CONNECT 代理建立到目标的 socket。 */
async function openProxySocket(proxy: HostProxy, target: ResolvedTarget): Promise<Duplex> {
  if (proxy.kind === 'socks5') {
    const { SocksClient } = await import('socks')
    const info = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        ...(proxy.username !== undefined ? { userId: proxy.username } : {}),
        ...(proxy.password !== undefined ? { password: proxy.password } : {})
      },
      command: 'connect',
      destination: { host: target.hostname, port: target.port }
    })
    return info.socket as unknown as Duplex
  }
  return await openHttpConnect(proxy, target)
}

/** HTTP CONNECT 隧道。 */
function openHttpConnect(proxy: HostProxy, target: ResolvedTarget): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    void import('node:http').then((http) => {
      const headers: Record<string, string> = {}
      if (proxy.username !== undefined) {
        const raw = `${proxy.username}:${proxy.password ?? ''}`
        headers['Proxy-Authorization'] = `Basic ${Buffer.from(raw).toString('base64')}`
      }
      const request = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port}`,
        headers,
        // 必须绕开连接代理（agent）：隧道是一次性专用连接，绝不能进入复用池。
        // Node 默认的全局 keep-alive agent 在代理回 `200 OK` + `Content-Length: 0` 时，
        // 会把这个套接字当成「响应已结束、可复用」收回空闲池，与隧道移交相互争抢，
        // 结果隧道里的数据（SSH 横幅）永远到不了 ssh2，表现为
        // 「Connection lost before handshake」。真机 A/B 验证：默认 agent 0/2，agent:false 2/2。
        agent: false
      })
      request.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          reject(new Error(`HTTP 代理拒绝连接：${response.statusCode} ${response.statusMessage}`))
          return
        }
        // 代理回应与隧道首批数据若落在同一个 TCP 包里，后者在 head 中，
        // 必须塞回套接字，否则 SSH 横幅会丢失。（本次排查中 head 恒为空，属防御性处理。）
        if (head.length > 0) socket.unshift(head)
        resolve(socket as unknown as Duplex)
      })
      request.once('error', reject)
      request.end()
    }, reject)
  })
}

/** 连接状态的初始值。 */
export function initialStatus(hostId: string): ConnectionStatus {
  return { hostId, phase: 'idle', reconnectCount: 0 }
}
