/*
 * @Description: 终端子系统测试 —— 回滚缓冲、注册表生命周期、信任围栏、真实 WebSocket 协议
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/terminal/terminal.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { ConnectionLog } from '../log/connection-log.js'
import { Scrollback, bytesForLines } from './scrollback.js'
import { TerminalRegistry, type ShellChannel, type ShellOpener } from './registry.js'
import { attachSocket, parseClientFrame, terminalIdFromUrl, type SocketLike } from './socket.js'
import { isTrustedRequest } from './trust-fence.js'
import { buildStartupLine, shellQuote } from './ssh-shell.js'

// ------------------------------------------------------------------ 替身

/** 假 shell 通道：记录写入与窗口尺寸，可手动推送输出与关闭。 */
class FakeChannel extends EventEmitter implements ShellChannel {
  written: string[] = []
  windows: Array<[number, number]> = []
  closed = false
  stderr = new EventEmitter()
  write(data: string | Buffer): boolean {
    this.written.push(data.toString())
    return true
  }
  setWindow(rows: number, cols: number): void {
    this.windows.push([rows, cols])
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  emitOutput(text: string | Buffer): void {
    this.emit('data', Buffer.isBuffer(text) ? text : Buffer.from(text))
  }
}

function fakeOpener(): { opener: ShellOpener; channels: FakeChannel[] } {
  const channels: FakeChannel[] = []
  const opener: ShellOpener = async () => {
    const ch = new FakeChannel()
    channels.push(ch)
    return ch
  }
  return { opener, channels }
}

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-term-'))
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

// ------------------------------------------------------------------ 回滚缓冲

describe('Scrollback', () => {
  it('不超限时原样保留', () => {
    const sb = new Scrollback(100)
    sb.push(Buffer.from('hello '))
    sb.push(Buffer.from('world'))
    expect(sb.snapshot().toString()).toBe('hello world')
  })

  it('超限时丢弃最旧内容', () => {
    const sb = new Scrollback(10)
    sb.push(Buffer.from('aaaaa'))
    sb.push(Buffer.from('bbbbb'))
    sb.push(Buffer.from('ccccc'))
    expect(sb.byteLength).toBeLessThanOrEqual(10)
    expect(sb.snapshot().toString()).toBe('bbbbbccccc')
  })

  it('单块巨量输出被裁剪，并尽量对齐到换行', () => {
    const sb = new Scrollback(64)
    sb.push(Buffer.from(`${'x'.repeat(100)}\n${'y'.repeat(60)}`))
    const text = sb.snapshot().toString()
    expect(text.length).toBeLessThanOrEqual(64)
    // 不应从 x 的半截开始。
    expect(text.startsWith('y')).toBe(true)
  })

  it('行数换算有下限', () => {
    expect(bytesForLines(10)).toBeGreaterThanOrEqual(64 * 1024)
    expect(bytesForLines(5000)).toBe(1_000_000)
  })
})

// ------------------------------------------------------------------ 注册表

describe('TerminalRegistry', () => {
  const make = (overrides: Partial<ConstructorParameters<typeof TerminalRegistry>[2]> = {}) => {
    const { opener, channels } = fakeOpener()
    const log = new ConnectionLog()
    const registry = new TerminalRegistry(opener, log, {
      scrollbackBytes: 1024,
      detachedTtlMs: 0,
      ...overrides
    })
    return { registry, channels, log }
  }

  it('打开后状态为 open，列表可见', async () => {
    const { registry } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 'srv' })
    expect(view.status).toBe('open')
    expect(registry.list()).toHaveLength(1)
    registry.dispose()
  })

  it('打开失败时不留下空壳会话，且错误原样抛出', async () => {
    const log = new ConnectionLog()
    const registry = new TerminalRegistry(
      async () => {
        throw new Error('vault locked')
      },
      log,
      { scrollbackBytes: 1024, detachedTtlMs: 0 }
    )
    await expect(registry.open('h1', { cols: 80, rows: 24, title: 't' })).rejects.toThrow('vault locked')
    expect(registry.list()).toHaveLength(0)
    expect(log.list('h1').some((e) => e.level === 'error')).toBe(true)
    registry.dispose()
  })

  it('新视图接入时先收到状态，再收到完整回放', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    channels[0]?.emitOutput('line1\r\n')
    channels[0]?.emitOutput('line2\r\n')

    const events: string[] = []
    registry.attach(view.id, {
      output: (chunk) => events.push(`out:${chunk.toString()}`),
      control: (m) => events.push(`ctl:${m.terminal.status}`)
    })
    expect(events[0]).toBe('ctl:open')
    expect(events[1]).toBe('out:line1\r\nline2\r\n')
    registry.dispose()
  })

  it('视图全部离开不杀进程 —— 刷新页面要能接回原终端', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const detach = registry.attach(view.id, { output: () => {}, control: () => {} })
    detach?.()
    expect(channels[0]?.closed).toBe(false)
    expect(registry.get(view.id)?.status).toBe('open')
    expect(registry.get(view.id)?.viewers).toBe(0)
    registry.dispose()
  })

  it('多个视图同时收到输出（管理页面与侧边栏看同一个终端）', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const a: string[] = []
    const b: string[] = []
    registry.attach(view.id, { output: (c) => a.push(c.toString()), control: () => {} })
    registry.attach(view.id, { output: (c) => b.push(c.toString()), control: () => {} })
    channels[0]?.emitOutput('shared')
    expect(a).toContain('shared')
    expect(b).toContain('shared')
    registry.dispose()
  })

  it('一个视图抛错不影响其他视图', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const good: string[] = []
    registry.attach(view.id, {
      output: () => {
        throw new Error('socket gone')
      },
      control: () => {}
    })
    registry.attach(view.id, { output: (c) => good.push(c.toString()), control: () => {} })
    channels[0]?.emitOutput('still delivered')
    expect(good).toContain('still delivered')
    registry.dispose()
  })

  it('resize 参数顺序正确（ssh2 是 rows, cols）且有边界', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    registry.resize(view.id, 120, 40)
    registry.resize(view.id, 99999, -5)
    expect(channels[0]?.windows).toEqual([
      [40, 120],
      [1, 1000]
    ])
    registry.dispose()
  })

  it('远端退出后状态变为 exited 并记录退出码', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const statuses: string[] = []
    registry.attach(view.id, { output: () => {}, control: (m) => statuses.push(m.terminal.status) })
    channels[0]?.emit('exit', 0)
    channels[0]?.close()
    const after = registry.get(view.id)
    expect(after?.status).toBe('exited')
    expect(after?.exitCode).toBe(0)
    expect(after?.reason).toContain('退出码 0')
    expect(statuses).toContain('exited')
    registry.dispose()
  })

  it('无退出码的关闭被识别为连接断开', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    channels[0]?.close()
    expect(registry.get(view.id)?.reason).toBe('连接已断开')
    registry.dispose()
  })

  it('close 移除会话并关闭通道', async () => {
    const { registry, channels } = make()
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    expect(registry.close(view.id)).toBe(true)
    expect(channels[0]?.closed).toBe(true)
    expect(registry.list()).toHaveLength(0)
    registry.dispose()
  })

  it('无人查看超过 TTL 被回收，后台保留的不回收', async () => {
    let now = 0
    const { registry, channels } = make({ detachedTtlMs: 1000, reapIntervalMs: 1e9, now: () => now })
    const a = await registry.open('h1', { cols: 80, rows: 24, title: 'a' })
    const b = await registry.open('h1', { cols: 80, rows: 24, title: 'b' })
    registry.setKeepAlive(b.id, true)
    now = 5000
    expect(registry.reap()).toBe(1)
    expect(registry.get(a.id)).toBeUndefined()
    expect(registry.get(b.id)?.status).toBe('open')
    expect(channels[0]?.closed).toBe(true)
    expect(channels[1]?.closed).toBe(false)
    registry.dispose()
  })

  it('有人在看的终端不会被回收', async () => {
    let now = 0
    const { registry } = make({ detachedTtlMs: 1000, reapIntervalMs: 1e9, now: () => now })
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    registry.attach(view.id, { output: () => {}, control: () => {} })
    now = 999_999
    expect(registry.reap()).toBe(0)
    registry.dispose()
  })

  it('closeHost 关闭该主机的全部终端，不影响其他主机', async () => {
    const { registry } = make()
    await registry.open('h1', { cols: 80, rows: 24, title: 'a' })
    await registry.open('h1', { cols: 80, rows: 24, title: 'b' })
    await registry.open('h2', { cols: 80, rows: 24, title: 'c' })
    expect(registry.closeHost('h1')).toBe(2)
    expect(registry.list().map((t) => t.hostId)).toEqual(['h2'])
    registry.dispose()
  })

  it('最近终端跨实例持久化，只记元数据', async () => {
    const recentFile = path.join(sandbox, 'terminals.json')
    const { opener } = fakeOpener()
    const first = new TerminalRegistry(opener, new ConnectionLog(), {
      scrollbackBytes: 1024,
      detachedTtlMs: 0,
      recentFile
    })
    await first.open('h1', { cols: 80, rows: 24, title: 'srv', cwd: '/opt/app' })
    // 模拟插件卸载：dispose 不应把列表清空写盘。
    first.dispose()

    const second = new TerminalRegistry(opener, new ConnectionLog(), {
      scrollbackBytes: 1024,
      detachedTtlMs: 0,
      recentFile
    })
    expect(second.listRecent()).toEqual([{ hostId: 'h1', title: 'srv', cwd: '/opt/app' }])
    second.dispose()
  })

  it('dispose 关闭全部通道', async () => {
    const { registry, channels } = make()
    await registry.open('h1', { cols: 80, rows: 24, title: 'a' })
    await registry.open('h2', { cols: 80, rows: 24, title: 'b' })
    registry.dispose()
    expect(channels.every((c) => c.closed)).toBe(true)
    await expect(registry.open('h1', { cols: 80, rows: 24, title: 'x' })).rejects.toThrow()
  })
})

// ------------------------------------------------------------------ 启动行

describe('启动命令组装', () => {
  it('单引号被正确转义，防止注入', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`)
  })

  it('环境变量、目录、启动命令合并成一行，行首带空格', () => {
    const line = buildStartupLine({
      env: { NODE_ENV: 'production', MSG: "a'b" },
      cwd: '/opt/my app',
      startupCommand: 'source venv/bin/activate'
    })
    expect(line).toBe(
      ` export NODE_ENV='production' MSG='a'\\''b'; cd -- '/opt/my app'; source venv/bin/activate\n`
    )
  })

  it('非法变量名被跳过并回调告知，而不是拼进命令', () => {
    const bad: string[] = []
    const line = buildStartupLine({
      env: { 'OK_1': 'v', 'bad-name': 'x', '1LEAD': 'y', 'A;rm': 'z' },
      onInvalidEnv: (n) => bad.push(n)
    })
    expect(line).toBe(` export OK_1='v'\n`)
    expect(bad.sort()).toEqual(['1LEAD', 'A;rm', 'bad-name'])
  })

  it('什么都没配时不发任何东西', () => {
    expect(buildStartupLine({})).toBeUndefined()
  })
})

// ------------------------------------------------------------------ 围栏

describe('信任围栏', () => {
  const req = (headers: Record<string, string>) => ({ headers })

  it('回环地址放行', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:43120' }), [])).toBe(true)
    expect(isTrustedRequest(req({ host: 'localhost:43120' }), [])).toBe(true)
  })

  it('未信任的局域网地址拒绝', () => {
    expect(isTrustedRequest(req({ host: '192.168.3.5:43120' }), [])).toBe(false)
  })

  it('显式信任的地址放行', () => {
    expect(isTrustedRequest(req({ host: '192.168.3.5:43120' }), ['192.168.3.5'])).toBe(true)
  })

  it('DNS 重绑定：Host 是回环但 Origin 是外站 → 拒绝', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:43120', origin: 'https://evil.example' }), [])).toBe(false)
  })

  it('跨站请求标记 → 拒绝', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
  })

  it('不透明来源 Origin: null → 拒绝', () => {
    expect(isTrustedRequest(req({ host: '127.0.0.1:43120', origin: 'null' }), [])).toBe(false)
  })

  it('缺 Host → 拒绝', () => {
    expect(isTrustedRequest(req({}), [])).toBe(false)
  })
})

// ------------------------------------------------------------------ 协议

describe('帧解析', () => {
  it('合法帧', () => {
    expect(parseClientFrame('{"t":"i","d":"ls\\r"}')).toEqual({ t: 'i', d: 'ls\r' })
    expect(parseClientFrame('{"t":"r","c":100,"r":30}')).toEqual({ t: 'r', c: 100, r: 30 })
    expect(parseClientFrame('{"t":"x"}')).toEqual({ t: 'x' })
  })

  it('畸形帧一律忽略', () => {
    for (const raw of ['not json', '{}', '{"t":"i"}', '{"t":"r","c":"1","r":2}', 'null', '[]']) {
      expect(parseClientFrame(raw)).toBeUndefined()
    }
  })

  it('URL 中的终端 id 只接受 UUID', () => {
    expect(terminalIdFromUrl('/p?id=3f2a8c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6')).toBe(
      '3f2a8c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6'
    )
    for (const url of ['/p', '/p?id=abc', '/p?id=../../etc', undefined]) {
      expect(terminalIdFromUrl(url)).toBeUndefined()
    }
  })
})

describe('真实 WebSocket 端到端', () => {
  let server: Server
  let wss: WebSocketServer
  let registry: TerminalRegistry
  let channels: FakeChannel[]
  let port: number

  beforeEach(async () => {
    const fake = fakeOpener()
    channels = fake.channels
    registry = new TerminalRegistry(fake.opener, new ConnectionLog(), { scrollbackBytes: 4096, detachedTtlMs: 0 })
    wss = new WebSocketServer({ noServer: true })
    server = createServer()
    server.on('upgrade', (req, socket, head) => {
      const id = terminalIdFromUrl(req.url)
      if (id === undefined) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => attachSocket(registry, ws as unknown as SocketLike, id))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    registry.dispose()
    for (const c of wss.clients) c.terminate()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** 连接并收集消息；二进制帧解为 Buffer，文本帧解为 JSON。 */
  const connect = (id: string) =>
    new Promise<{ ws: WebSocket; binary: Buffer[]; control: unknown[]; closeCode: () => number | undefined }>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/t?id=${id}`)
        const binary: Buffer[] = []
        const control: unknown[] = []
        let code: number | undefined
        ws.on('message', (data, isBinary) => {
          if (isBinary) binary.push(Buffer.from(data as Buffer))
          else control.push(JSON.parse(data.toString()))
        })
        ws.on('close', (c) => {
          code = c
        })
        ws.on('open', () => resolve({ ws, binary, control, closeCode: () => code }))
        ws.on('error', reject)
      }
    )

  const settle = () => new Promise((r) => setTimeout(r, 60))

  it('键盘输入经 JSON 帧抵达远端通道', async () => {
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const { ws } = await connect(view.id)
    ws.send(JSON.stringify({ t: 'i', d: 'echo hi\r' }))
    ws.send(JSON.stringify({ t: 'r', c: 132, r: 43 }))
    await settle()
    expect(channels[0]?.written).toContain('echo hi\r')
    expect(channels[0]?.windows).toContainEqual([43, 132])
    ws.close()
  })

  it('形如控制帧的粘贴文本不会被误判（输入走 JSON 封装）', async () => {
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const { ws } = await connect(view.id)
    const pasted = '{"type":"resize","cols":1,"rows":1}'
    ws.send(JSON.stringify({ t: 'i', d: pasted }))
    await settle()
    expect(channels[0]?.written).toContain(pasted)
    expect(channels[0]?.windows).toEqual([])
    ws.close()
  })

  it('断开重连后收到完整回放 —— 刷新页面能接回终端', async () => {
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const first = await connect(view.id)
    channels[0]?.emitOutput('before-refresh\r\n')
    await settle()
    first.ws.close()
    await settle()

    channels[0]?.emitOutput('while-away\r\n')
    const second = await connect(view.id)
    await settle()
    const replay = Buffer.concat(second.binary).toString()
    expect(replay).toContain('before-refresh')
    expect(replay).toContain('while-away')
    second.ws.close()
  })

  it('被切开的 UTF-8 多字节字符经二进制帧仍可正确拼接', async () => {
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const { ws, binary } = await connect(view.id)
    const bytes = Buffer.from('中文', 'utf8') // 6 字节
    channels[0]?.emitOutput(bytes.subarray(0, 4)) // 从「文」的中间切开
    channels[0]?.emitOutput(bytes.subarray(4))
    await settle()
    // 浏览器端 xterm 做的正是按字节流拼接后解码；这里模拟同样的拼接。
    expect(Buffer.concat(binary).toString('utf8')).toBe('中文')
    ws.close()
  })

  it('不存在的终端以 4404 关闭，浏览器据此停止重连', async () => {
    const { closeCode } = await connect('00000000-0000-4000-8000-000000000000')
    await settle()
    expect(closeCode()).toBe(4404)
  })

  it('x 帧关闭终端', async () => {
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const { ws } = await connect(view.id)
    ws.send(JSON.stringify({ t: 'x' }))
    await settle()
    expect(channels[0]?.closed).toBe(true)
    expect(registry.get(view.id)).toBeUndefined()
    ws.close()
  })

  it('socket 断开后视图数归零（供回收判断）', async () => {
    const view = await registry.open('h1', { cols: 80, rows: 24, title: 't' })
    const { ws } = await connect(view.id)
    await settle()
    expect(registry.get(view.id)?.viewers).toBe(1)
    ws.close()
    await settle()
    expect(registry.get(view.id)?.viewers).toBe(0)
  })
})
