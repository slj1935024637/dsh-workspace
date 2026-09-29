/*
 * @Description: 终端 WebSocket 协议 —— 输出走二进制帧，控制走 JSON 文本帧
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/terminal/socket.ts
 *
 * 协议：
 *   浏览器 → 宿主（全部是 JSON 文本帧）
 *     { t: 'i', d: string }          键盘输入
 *     { t: 'r', c: number, r: number } 窗口尺寸（cols, rows）
 *     { t: 'x' }                     关闭终端（杀掉远端进程）
 *   宿主 → 浏览器
 *     二进制帧                         终端原始输出字节
 *     文本帧 { t: 'status', terminal } 状态变化
 *
 * 为什么输出用二进制：UTF-8 多字节字符（中文）可能被切在两个 chunk 之间。
 * 若按文本帧逐块解码再发送，切口处会变成乱码；原样发字节交给 xterm，
 * 它会跨 chunk 正确拼接解码。
 *
 * 为什么输入也包成 JSON：若输入走裸文本、控制走 JSON（better-sidebar 的做法），
 * 用户粘贴一段恰好形如 {"type":"resize"} 的文本就会被误判为控制帧。
 */
import type { TerminalRegistry, TerminalViewer } from './registry.js'
import { WS_CLOSE_NOT_FOUND } from '../wire/contract.js'

/** 单帧输入上限。粘贴大段文本属正常，但无上限的帧是内存攻击面。 */
const MAX_FRAME_BYTES = 1024 * 1024
/** 心跳间隔：探测掉线但未发 close 的浏览器（合盖、断网）。 */
const HEARTBEAT_MS = 30_000

/** ws 包 WebSocket 的最小结构约束。 */
export interface SocketLike {
  readonly readyState: number
  send(data: string | Buffer, options?: { binary?: boolean }): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'pong', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

const OPEN = 1

type ClientFrame = { t: 'i'; d: string } | { t: 'r'; c: number; r: number } | { t: 'x' }

export function parseClientFrame(raw: string): ClientFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const frame = value as Record<string, unknown>
  if (frame.t === 'i' && typeof frame.d === 'string') return { t: 'i', d: frame.d }
  if (frame.t === 'r' && typeof frame.c === 'number' && typeof frame.r === 'number') {
    return { t: 'r', c: frame.c, r: frame.r }
  }
  if (frame.t === 'x') return { t: 'x' }
  return undefined
}

/**
 * 把一条已升级的 WebSocket 挂到指定终端上。
 * 终端不存在时以 4404 关闭：浏览器据此知道不必重连（终端已被关闭或回收）。
 */
export function attachSocket(registry: TerminalRegistry, socket: SocketLike, terminalId: string): void {
  const viewer: TerminalViewer = {
    output(chunk) {
      if (socket.readyState === OPEN) socket.send(chunk, { binary: true })
    },
    control(message) {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(message))
    }
  }

  const detach = registry.attach(terminalId, viewer)
  if (detach === undefined) {
    socket.close(WS_CLOSE_NOT_FOUND, 'terminal not found')
    return
  }

  let alive = true
  const heartbeat = setInterval(() => {
    if (!alive) {
      // 上一轮 ping 没有回 pong：连接已死，主动断开以便注册表把视图数减掉。
      socket.terminate()
      return
    }
    alive = false
    try {
      socket.ping()
    } catch {
      socket.terminate()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  socket.on('pong', () => {
    alive = true
  })

  socket.on('message', (data, isBinary) => {
    alive = true
    if (isBinary) return
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8')
    if (text.length > MAX_FRAME_BYTES) return
    const frame = parseClientFrame(text)
    if (frame === undefined) return
    if (frame.t === 'i') registry.input(terminalId, frame.d)
    else if (frame.t === 'r') registry.resize(terminalId, frame.c, frame.r)
    else registry.close(terminalId)
  })

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeat)
    detach()
  }
  socket.on('close', cleanup)
  socket.on('error', cleanup)
}

/** 从升级请求的 URL 中取终端 id。只接受 UUID 形态，其余一律拒绝。 */
export function terminalIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    return undefined
  }
  const id = parsed.searchParams.get('id')
  return id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : undefined
}
