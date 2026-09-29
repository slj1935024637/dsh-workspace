/*
 * @Description: 浏览器端终端连接的重连状态机测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/terminal/link.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalLink, terminalSocketUrl, type WebSocketLike } from './link.js'

class FakeSocket implements WebSocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  onerror: WebSocketLike['onerror'] = null
  sent: string[] = []
  closedWith: number | undefined
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.closedWith = code
    this.readyState = 3
  }
  // 测试驱动
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const events: string[] = []
  const output: string[] = []
  const link = new TerminalLink(
    'ws://x/t?id=1',
    {
      onAttach: () => events.push('attach'),
      onOutput: (b) => output.push(new TextDecoder().decode(b)),
      onStatus: (t) => events.push(`status:${t.status}`),
      onLinkState: (s) => events.push(`link:${s}`)
    },
    (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    }
  )
  return { link, sockets, events, output }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('TerminalLink', () => {
  it('连接后以 arraybuffer 接收二进制', () => {
    const { link, sockets } = setup()
    link.connect()
    expect(sockets[0]?.binaryType).toBe('arraybuffer')
  })

  it('二进制帧 → 输出；文本帧 → 状态', () => {
    const { link, sockets, events, output } = setup()
    link.connect()
    sockets[0]?.open()
    sockets[0]?.onmessage?.({ data: new TextEncoder().encode('hi').buffer })
    sockets[0]?.onmessage?.({ data: JSON.stringify({ t: 'status', terminal: { status: 'open' } }) })
    expect(output).toEqual(['hi'])
    expect(events).toContain('status:open')
  })

  it('意外断开后按退避重连，重连成功会再次触发 attach（清屏后接收回放）', () => {
    const { link, sockets, events } = setup()
    link.connect()
    sockets[0]?.open()
    sockets[0]?.drop()
    expect(events).toContain('link:reconnecting')
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    expect(events.filter((e) => e === 'attach')).toHaveLength(2)
  })

  it('退避时长逐次增加且有上限', () => {
    const { link, sockets } = setup()
    link.connect()
    const delays = [500, 1000, 2000, 4000, 8000, 8000]
    for (const delay of delays) {
      sockets[sockets.length - 1]?.drop()
      const before = sockets.length
      vi.advanceTimersByTime(delay - 1)
      expect(sockets.length).toBe(before)
      vi.advanceTimersByTime(1)
      expect(sockets.length).toBe(before + 1)
    }
  })

  it('收到 4404（终端已不存在）永久停止，不再重连', () => {
    const { link, sockets, events } = setup()
    link.connect()
    sockets[0]?.open()
    sockets[0]?.drop(4404)
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(events[events.length - 1]).toBe('link:gone')
  })

  it('断线期间的尺寸变更在重连后补发', () => {
    const { link, sockets } = setup()
    link.connect()
    sockets[0]?.open()
    sockets[0]?.drop()
    link.sendResize(150, 50)
    vi.advanceTimersByTime(500)
    sockets[1]?.open()
    expect(sockets[1]?.sent).toContain(JSON.stringify({ t: 'r', c: 150, r: 50 }))
  })

  it('未连接时的输入不会抛错', () => {
    const { link } = setup()
    link.connect()
    expect(() => link.sendInput('ls')).not.toThrow()
  })

  it('dispose 后关闭 socket 且不再重连', () => {
    const { link, sockets } = setup()
    link.connect()
    sockets[0]?.open()
    link.dispose()
    expect(sockets[0]?.closedWith).toBe(1000)
    sockets[0]?.drop()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('输入、尺寸、关闭帧的格式与宿主端协议一致', () => {
    const { link, sockets } = setup()
    link.connect()
    sockets[0]?.open()
    link.sendInput('ls\r')
    link.sendResize(80, 24)
    link.sendClose()
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ t: 'i', d: 'ls\r' }),
      JSON.stringify({ t: 'r', c: 80, r: 24 }),
      JSON.stringify({ t: 'x' })
    ])
  })
})

describe('terminalSocketUrl', () => {
  it('http → ws，https → wss，并编码 id', () => {
    expect(terminalSocketUrl('a b', { protocol: 'http:', host: '127.0.0.1:43120' })).toBe(
      'ws://127.0.0.1:43120/dsh-workspace/ws/terminal?id=a%20b'
    )
    expect(terminalSocketUrl('x', { protocol: 'https:', host: 'dsh.example' })).toBe(
      'wss://dsh.example/dsh-workspace/ws/terminal?id=x'
    )
  })
})
