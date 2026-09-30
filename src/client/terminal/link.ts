/*
 * @Description: 浏览器端终端连接 —— 断线自动重连，终端不存在时停止
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/terminal/link.ts
 */
import { TERMINAL_WS_PATH, WS_CLOSE_NOT_FOUND } from '../../wire/contract.js'
import type { TerminalView } from '../../wire/dto.js'

/** WebSocket 的最小结构约束（便于测试替身）。 */
export interface WebSocketLike {
  binaryType: string
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface TerminalLinkHandlers {
  /** 每次（重新）连上时调用：视图应清屏，随后服务端会整段回放。 */
  onAttach(): void
  onOutput(bytes: Uint8Array): void
  onStatus(terminal: TerminalView): void
  /** 连接状态变化，供 UI 显示「重连中」。 */
  onLinkState(state: 'connecting' | 'open' | 'reconnecting' | 'gone'): void
}

const OPEN = 1
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

/**
 * 终端 WebSocket 地址。
 * DSH 桌面版的页面可以不由宿主 HTTP 服务提供（页面来源 ≠ 宿主地址），此时宿主通过
 * `__DSH_TRANSPORT__.streamBaseUrl` 告知真正的服务地址，宿主自己的流通道也是这么取的
 * （dsh-api-gateway 的 remoteStreamUrl）。只用 window.location 在这种页面上会连到错误的地址，
 * 表现为终端一直「连接中断，正在重连」，而走 RPC 的 SFTP 列目录一切正常。
 * @param streamBaseUrl 宿主提供的服务地址；缺省时用页面地址。
 */
export function terminalSocketUrl(terminalId: string, location: { protocol: string; host: string }, streamBaseUrl?: string): string {
  let protocol = location.protocol
  let host = location.host
  if (streamBaseUrl !== undefined && streamBaseUrl !== '') {
    try {
      const base = new URL(streamBaseUrl)
      protocol = base.protocol
      host = base.host
    } catch {
      /* 地址不合法就退回页面地址 */
    }
  }
  const scheme = protocol === 'https:' || protocol === 'wss:' ? 'wss:' : 'ws:'
  return `${scheme}//${host}${TERMINAL_WS_PATH}?id=${encodeURIComponent(terminalId)}`
}

export { hostStreamBaseUrl } from '../host-url.js'

/**
 * 一条到指定终端的连接。
 *
 * 重连策略：意外断开（网络抖动、宿主重载）按退避重连；
 * 收到 4404（终端已关闭或被回收）则永久停止 —— 否则一个关掉的终端会在后台无限重试。
 */
export class TerminalLink {
  private socket: WebSocketLike | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** 断线期间的尺寸变更，连上后补发最后一次。 */
  private pendingSize: { cols: number; rows: number } | undefined

  constructor(
    private readonly url: string,
    private readonly handlers: TerminalLinkHandlers,
    private readonly createSocket: WebSocketFactory
  ) {}

  connect(): void {
    if (this.disposed) return
    this.handlers.onLinkState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = this.createSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.handlers.onAttach()
      this.handlers.onLinkState('open')
      if (this.pendingSize !== undefined) {
        this.sendResize(this.pendingSize.cols, this.pendingSize.rows)
      }
    }
    socket.onmessage = (event) => {
      const data = event.data
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data) as { t?: string; terminal?: TerminalView }
          if (message.t === 'status' && message.terminal !== undefined) this.handlers.onStatus(message.terminal)
        } catch {
          /* 忽略无法解析的控制帧 */
        }
        return
      }
      if (data instanceof ArrayBuffer) this.handlers.onOutput(new Uint8Array(data))
      else if (ArrayBuffer.isView(data)) {
        this.handlers.onOutput(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      }
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.disposed) return
      if (event.code === WS_CLOSE_NOT_FOUND) {
        this.handlers.onLinkState('gone')
        return
      }
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      // onerror 之后浏览器总会触发 onclose，重连逻辑统一放在那里。
    }
  }

  private scheduleReconnect(): void {
    // 首次失败时在控制台留下目标地址：连不上的原因（地址错 / 被信任围栏拒绝）只能靠它和插件日志区分。
    if (this.attempt === 0) console.warn(`[dsh-workspace] 终端连接断开，正在重连：${this.url.replace(/\?.*$/, '')}`)
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number
    this.attempt += 1
    this.handlers.onLinkState('reconnecting')
    this.timer = setTimeout(() => this.connect(), delay)
  }

  sendInput(data: string): void {
    this.send({ t: 'i', d: data })
  }

  sendResize(cols: number, rows: number): void {
    this.pendingSize = { cols, rows }
    this.send({ t: 'r', c: cols, r: rows })
  }

  /** 请求关闭远端终端（杀掉进程）。 */
  sendClose(): void {
    this.send({ t: 'x' })
  }

  private send(frame: unknown): void {
    if (this.socket !== null && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(frame))
  }

  /** 断开本视图（不杀远端进程：其他视图或刷新后仍可接回）。 */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'view closed')
  }
}
