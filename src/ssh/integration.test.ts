/*
 * @Description: 真机集成测试 —— 直连 / 跳板链 / HTTP 代理 三条路径 + SFTP 读写
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/integration.test.ts
 *
 * 默认跳过。仅当设置 DSHWS_IT=1 时运行，凭据全部来自环境变量，不落盘：
 *   DSHWS_DIRECT   = host:port:user:password         直连目标
 *   DSHWS_JUMP     = host:port:user:password         跳板机（目标复用 DSHWS_DIRECT）
 *   DSHWS_PROXY    = http://host:port                HTTP 代理
 *   DSHWS_PROXIED  = host:port:user:password         经代理访问的目标
 *
 * 远端操作约束：只在 mktemp 创建的 /tmp 临时目录内读写，结束只删除该目录。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshConnection } from './connection.js'
import { KnownHosts } from './hostkey.js'
import { SshPool } from './pool.js'
import { ConnectionLog } from '../log/connection-log.js'
import { TerminalRegistry } from '../terminal/registry.js'
import { createSshShellOpener } from '../terminal/ssh-shell.js'
import type { WorkspaceRuntime } from '../runtime.js'
import type { HostProxy, ResolvedTarget } from '../types.js'

const enabled = process.env.DSHWS_IT === '1'

interface Creds {
  host: string
  port: number
  user: string
  password: string
}

function parseCreds(raw: string | undefined): Creds | undefined {
  if (raw === undefined || raw === '') return undefined
  // 密码里可能含冒号，所以只切前三段。
  const [host, port, user, ...rest] = raw.split(':')
  if (host === undefined || port === undefined || user === undefined) return undefined
  return { host, port: Number(port), user, password: rest.join(':') }
}

function targetOf(id: string, c: Creds, extra: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    hostId: id,
    label: id,
    hostname: c.host,
    port: c.port,
    username: c.user,
    auth: { kind: 'password', password: c.password },
    jumpChain: [],
    ...extra
  }
}

/** 在连接上执行一条命令，收集 stdout 与退出码。 */
function run(conn: SshConnection, command: string): Promise<{ out: string; code: number }> {
  return new Promise((resolve, reject) => {
    conn.raw().exec(command, {}, (err, stream) => {
      if (err !== null && err !== undefined) {
        reject(err)
        return
      }
      const s = stream as NodeJS.ReadableStream & {
        on(e: 'close', l: (code: number) => void): void
        stderr: NodeJS.ReadableStream
      }
      let out = ''
      s.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      s.stderr.on('data', () => {
        /* stderr 不影响断言 */
      })
      s.on('close', (code: number) => {
        resolve({ out, code })
      })
    })
  })
}

/** 打开 SFTP 子系统。 */
function openSftp(conn: SshConnection): Promise<SftpLike> {
  return new Promise((resolve, reject) => {
    conn.raw().sftp((err, sftp) => {
      if (err !== null && err !== undefined) reject(err)
      else resolve(sftp as SftpLike)
    })
  })
}

interface SftpLike {
  writeFile(p: string, data: string, cb: (err: Error | null | undefined) => void): void
  readFile(p: string, cb: (err: Error | null | undefined, data: Buffer) => void): void
  readdir(p: string, cb: (err: Error | null | undefined, list: Array<{ filename: string }>) => void): void
  end(): void
}

const promisify =
  <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void) =>
  (): Promise<T> =>
    new Promise((resolve, reject) => {
      fn((err, v) => {
        if (err !== null && err !== undefined) reject(err)
        else resolve(v)
      })
    })

describe.runIf(enabled)('真机集成', () => {
  let sandbox: string
  const log = new ConnectionLog()

  beforeAll(() => {
    // 指纹库写进临时 DSH_HOME，不污染用户真实的 known-hosts。
    sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-it-'))
    process.env.DSH_HOME = sandbox
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('直连：握手、执行命令、TOFU 首次记录', async () => {
    const c = parseCreds(process.env.DSHWS_DIRECT)
    expect(c, 'DSHWS_DIRECT 未设置').toBeDefined()
    const known = new KnownHosts()
    const conn = await SshConnection.connect(targetOf('direct', c as Creds), known, log)
    try {
      const { out, code } = await run(conn, 'echo dshws-ok && uname -s')
      expect(code).toBe(0)
      expect(out).toContain('dshws-ok')
      expect(out).toContain('Linux')
      expect(known.list().map((k) => k.endpoint)).toContain(`${c?.host}:${c?.port}`)
    } finally {
      conn.close()
    }
  })

  it('直连：再次连接时指纹一致被放行', async () => {
    const c = parseCreds(process.env.DSHWS_DIRECT) as Creds
    const known = new KnownHosts()
    const conn = await SshConnection.connect(targetOf('direct', c), known, log)
    conn.close()
    const again = await SshConnection.connect(targetOf('direct', c), known, log)
    again.close()
  })

  it('跳板链：经跳板机到达目标', async () => {
    const jump = parseCreds(process.env.DSHWS_JUMP)
    const dest = parseCreds(process.env.DSHWS_DIRECT)
    expect(jump, 'DSHWS_JUMP 未设置').toBeDefined()
    const target = targetOf('via-jump', dest as Creds, {
      jumpChain: [targetOf('bastion', jump as Creds)]
    })
    const conn = await SshConnection.connect(target, new KnownHosts(), log)
    try {
      const { out, code } = await run(conn, 'echo via-jump-ok')
      expect(code).toBe(0)
      expect(out).toContain('via-jump-ok')
    } finally {
      conn.close()
    }
  })

  it('HTTP 代理：经 CONNECT 隧道到达目标', async () => {
    const proxyUrl = process.env.DSHWS_PROXY
    const dest = parseCreds(process.env.DSHWS_PROXIED)
    expect(proxyUrl, 'DSHWS_PROXY 未设置').toBeDefined()
    const u = new URL(proxyUrl as string)
    const proxy: HostProxy = { kind: 'http', host: u.hostname, port: Number(u.port) }
    const conn = await SshConnection.connect(
      targetOf('via-proxy', dest as Creds, { proxy }),
      new KnownHosts(),
      log
    )
    try {
      const { out, code } = await run(conn, 'echo via-proxy-ok')
      expect(code).toBe(0)
      expect(out).toContain('via-proxy-ok')
    } finally {
      conn.close()
    }
  })

  it('SFTP：只在 /tmp 自建目录内写读列，结束只删该目录', async () => {
    const c = parseCreds(process.env.DSHWS_DIRECT) as Creds
    const conn = await SshConnection.connect(targetOf('sftp', c), new KnownHosts(), log)
    let dir = ''
    try {
      // mktemp 保证目录名唯一，不会撞上任何已有文件。
      const made = await run(conn, 'mktemp -d /tmp/dshws-it.XXXXXX')
      dir = made.out.trim()
      expect(dir).toMatch(/^\/tmp\/dshws-it\.[A-Za-z0-9]+$/)

      const sftp = await openSftp(conn)
      const file = `${dir}/hello.txt`
      await promisify<void>((cb) => sftp.writeFile(file, '你好 dsh-workspace', (e) => cb(e, undefined)))()
      const data = await promisify<Buffer>((cb) => sftp.readFile(file, cb))()
      expect(data.toString('utf8')).toBe('你好 dsh-workspace')
      const list = await promisify<Array<{ filename: string }>>((cb) => sftp.readdir(dir, cb))()
      expect(list.map((e) => e.filename)).toContain('hello.txt')
      sftp.end()
    } finally {
      // 严格限定删除范围：只删 mktemp 出来且通过格式校验的那个目录。
      if (/^\/tmp\/dshws-it\.[A-Za-z0-9]+$/.test(dir)) {
        await run(conn, `rm -rf -- '${dir}'`)
        const check = await run(conn, `test -e '${dir}' && echo exists || echo gone`)
        expect(check.out.trim()).toBe('gone')
      }
      conn.close()
    }
  })

  it('连接池：分池独立、并发合并、dispose 回收', async () => {
    const c = parseCreds(process.env.DSHWS_DIRECT) as Creds
    const pool = new SshPool(new KnownHosts(), log)
    const resolve = (): ResolvedTarget => targetOf('pooled', c)
    const [a, b] = await Promise.all([
      pool.acquire('pooled', 'terminal', resolve),
      pool.acquire('pooled', 'terminal', resolve)
    ])
    // 并发 acquire 必须拿到同一条连接。
    expect(a).toBe(b)
    const f = await pool.acquire('pooled', 'file', resolve)
    // 终端池与文件池是两条独立连接。
    expect(f).not.toBe(a)
    expect(pool.statusOf('pooled', 'terminal').phase).toBe('ready')
    expect(pool.statusOf('pooled', 'terminal').latencyMs).toBeGreaterThan(0)
    pool.dispose()
  })

  it('错误密码：失败留痕，且只尝试一次（避免触发服务端 fail2ban）', async () => {
    const c = parseCreds(process.env.DSHWS_DIRECT) as Creds
    const localLog = new ConnectionLog()
    const pool = new SshPool(new KnownHosts(), localLog, {
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 10
    })
    await expect(
      pool.acquire('badpw', 'terminal', () =>
        targetOf('badpw', { ...c, password: 'definitely-wrong' })
      )
    ).rejects.toThrow()
    expect(pool.statusOf('badpw', 'terminal').phase).toBe('error')
    expect(localLog.list('badpw').some((e) => e.level === 'error')).toBe(true)
    // 真实服务器返回的认证失败必须被识别为不可重试：连续失败可能触发 fail2ban 封禁 IP。
    expect(localLog.list('badpw').some((e) => e.message.includes('重试'))).toBe(false)
    pool.dispose()
  })

  /**
   * 交互式终端真机测试：经真实 shell 打开器（含启动行注入）拿到 PTY，
   * 验证环境变量与工作目录生效、输入输出往返、窗口尺寸、中文输出。
   * 只执行 cd /tmp 与 echo / stty，不修改远端任何东西。
   */
  it('交互式终端：启动行生效、输入输出往返、尺寸同步、中文不乱码', async () => {
    const c = parseCreds(process.env.DSHWS_DIRECT) as Creds
    const log = new ConnectionLog()
    const known = new KnownHosts()
    const pool = new SshPool(known, log)
    // 构造一个最小运行时：目标带环境变量，验证 export 注入真的生效。
    const target = targetOf('term', c, { environmentVariables: { DSHWS_PROBE: "it's-ok" } })
    const rt = { pool, log, resolveHost: () => target } as unknown as WorkspaceRuntime
    const registry = new TerminalRegistry(createSshShellOpener(rt), log, {
      scrollbackBytes: 256 * 1024,
      detachedTtlMs: 0
    })

    try {
      const view = await registry.open('term', { cols: 100, rows: 30, cwd: '/tmp', title: 'it' })
      expect(view.status).toBe('open')

      const chunks: Buffer[] = []
      registry.attach(view.id, { output: (b) => chunks.push(b), control: () => {} })
      const text = () => Buffer.concat(chunks).toString('utf8')
      const waitFor = async (needle: string, ms = 8000) => {
        const start = Date.now()
        while (!text().includes(needle)) {
          if (Date.now() - start > ms) throw new Error(`等待输出超时：${needle}\n---\n${text().slice(-800)}`)
          await new Promise((r) => setTimeout(r, 50))
        }
      }

      // 用标记夹住输出，避免把回显的命令本身误当成结果。
      registry.input(view.id, 'echo "[P:$DSHWS_PROBE]" "[D:$(pwd)]"\r')
      await waitFor("[P:it's-ok]")
      await waitFor('[D:/tmp]')

      registry.resize(view.id, 132, 43)
      registry.input(view.id, 'echo "[S:$(stty size)]"\r')
      await waitFor('[S:43 132]')

      registry.input(view.id, 'echo "[Z:中文输出]"\r')
      await waitFor('[Z:中文输出]')

      registry.input(view.id, 'exit\r')
      const start = Date.now()
      while (registry.get(view.id)?.status !== 'exited') {
        if (Date.now() - start > 5000) throw new Error('exit 后终端未进入 exited 状态')
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(registry.get(view.id)?.exitCode).toBe(0)
    } finally {
      registry.dispose()
      pool.dispose()
    }
  })
})
