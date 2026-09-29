/*
 * @Description: 终端会话注册表 —— 管理页面与侧边栏共享同一会话，WS 断开不杀进程
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/terminal/registry.ts
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ConnectionLog } from '../log/connection-log.js'
import { Scrollback } from './scrollback.js'

/** 远端 shell 通道的最小结构约束（ssh2 ClientChannel 的子集），便于测试替身。 */
export interface ShellChannel {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'exit', listener: (code: number | null, signal?: string) => void): unknown
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  write(data: string | Buffer): unknown
  setWindow(rows: number, cols: number, height: number, width: number): unknown
  close(): unknown
}

export interface OpenShellOptions {
  cols: number
  rows: number
  cwd?: string
}

/** 打开一个远端 shell。实现方负责连接复用、凭据解析、启动命令注入。 */
export type ShellOpener = (hostId: string, options: OpenShellOptions) => Promise<ShellChannel>

export type TerminalStatus = 'opening' | 'open' | 'exited'

/** 传给浏览器的终端视图。 */
export interface TerminalView {
  id: string
  hostId: string
  title: string
  status: TerminalStatus
  createdAt: string
  exitCode?: number | null
  /** 退出原因（连接断开、远端退出等），给用户看。 */
  reason?: string
  /** 后台保留：无人查看时也不回收。 */
  keepAlive: boolean
  /** 当前挂着的视图数（页面 / 侧边栏）。 */
  viewers: number
}

/** 上次运行时打开过、可一键重开的终端。 */
export interface RecentTerminal {
  hostId: string
  title: string
  cwd?: string
}

/** 服务端推给视图的控制消息。输出走二进制帧，不经过这里。 */
export type TerminalControl = { t: 'status'; terminal: TerminalView }

/** 一个视图（一条 WebSocket）。 */
export interface TerminalViewer {
  output(chunk: Buffer): void
  control(message: TerminalControl): void
}

interface Session {
  id: string
  hostId: string
  title: string
  cwd?: string
  status: TerminalStatus
  createdAt: string
  exitCode?: number | null
  reason?: string
  keepAlive: boolean
  channel: ShellChannel | null
  scrollback: Scrollback
  viewers: Set<TerminalViewer>
  /** 最后一个视图离开的时间；有视图时为 undefined。 */
  detachedAt?: number
}

export interface TerminalRegistryOptions {
  scrollbackBytes: number
  /** 无人查看的终端多久后回收（毫秒）。0 表示不回收。 */
  detachedTtlMs: number
  /** 回收检查间隔。 */
  reapIntervalMs?: number
  /** 「上次打开的终端」持久化文件；缺省则不持久化。 */
  recentFile?: string
  now?: () => number
}

export class TerminalRegistry {
  private sessions = new Map<string, Session>()
  private recent: RecentTerminal[] = []
  private reaper: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private readonly now: () => number

  constructor(
    private readonly openShell: ShellOpener,
    private readonly log: ConnectionLog,
    private readonly options: TerminalRegistryOptions
  ) {
    this.now = options.now ?? Date.now
    this.recent = this.loadRecent()
    if (options.detachedTtlMs > 0) {
      this.reaper = setInterval(() => this.reap(), options.reapIntervalMs ?? 60_000)
      // 回收定时器不应阻止进程退出。
      this.reaper.unref?.()
    }
  }

  // ---------------------------------------------------------------- 打开 / 关闭

  /**
   * 打开一个终端。等待 shell 真正就绪才返回：失败（保险箱锁定、认证失败、
   * 通道数超限）要以异常抛给调用方，浏览器据此弹解锁框或显示原因，
   * 而不是先给一个「打开中」的空壳再在里面默默报错。
   */
  async open(hostId: string, options: OpenShellOptions & { title: string }): Promise<TerminalView> {
    if (this.disposed) throw new Error('终端服务已停止。')
    const session: Session = {
      id: randomUUID(),
      hostId,
      title: options.title,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      status: 'opening',
      createdAt: new Date(this.now()).toISOString(),
      keepAlive: false,
      channel: null,
      scrollback: new Scrollback(this.options.scrollbackBytes),
      viewers: new Set(),
      detachedAt: this.now()
    }
    this.sessions.set(session.id, session)

    let channel: ShellChannel
    try {
      channel = await this.openShell(hostId, options)
    } catch (error) {
      this.sessions.delete(session.id)
      this.log.error(hostId, 'terminal', '打开终端失败。', error)
      throw error
    }

    // 打开期间注册表可能已被释放（插件卸载），此时立即关掉这条孤儿通道。
    if (this.disposed || !this.sessions.has(session.id)) {
      safeClose(channel)
      throw new Error('终端在打开过程中被关闭。')
    }

    session.channel = channel
    session.status = 'open'
    this.bindChannel(session, channel)
    this.persistRecent()
    this.log.info(hostId, 'terminal', `已打开终端「${session.title}」。`)
    this.broadcast(session)
    return viewOf(session)
  }

  private bindChannel(session: Session, channel: ShellChannel): void {
    const onData = (chunk: Buffer): void => {
      session.scrollback.push(chunk)
      for (const viewer of session.viewers) safeCall(() => viewer.output(chunk))
    }
    channel.on('data', onData)
    // 分配了 pty 时 stderr 通常已并入 stdout，这里兜底，避免漏掉错误输出。
    channel.stderr?.on('data', onData)
    channel.on('exit', (code) => {
      session.exitCode = code
    })
    channel.on('close', () => {
      if (session.status === 'exited') return
      session.status = 'exited'
      session.channel = null
      session.reason ??=
        session.exitCode === undefined || session.exitCode === null
          ? '连接已断开'
          : `进程已退出（退出码 ${session.exitCode}）`
      this.log.info(session.hostId, 'terminal', `终端「${session.title}」已结束：${session.reason}。`)
      this.persistRecent()
      this.broadcast(session)
    })
  }

  /** 关闭并移除一个终端（用户关掉标签页）。 */
  close(id: string): boolean {
    const session = this.sessions.get(id)
    if (session === undefined) return false
    session.reason = '已手动关闭'
    if (session.channel !== null) safeClose(session.channel)
    session.channel = null
    session.status = 'exited'
    this.broadcast(session)
    this.sessions.delete(id)
    this.persistRecent()
    return true
  }

  // ---------------------------------------------------------------- 视图

  /**
   * 挂上一个视图：先推状态，再整段回放 scrollback。
   * 返回卸载函数；终端不存在返回 undefined。
   */
  attach(id: string, viewer: TerminalViewer): (() => void) | undefined {
    const session = this.sessions.get(id)
    if (session === undefined) return undefined
    session.viewers.add(viewer)
    session.detachedAt = undefined
    safeCall(() => viewer.control({ t: 'status', terminal: viewOf(session) }))
    const replay = session.scrollback.snapshot()
    if (replay.length > 0) safeCall(() => viewer.output(replay))
    this.broadcast(session)
    return () => {
      if (!session.viewers.delete(viewer)) return
      // 视图全部离开不杀进程：刷新页面要能接回原终端。回收交给 TTL。
      if (session.viewers.size === 0) session.detachedAt = this.now()
      this.broadcast(session)
    }
  }

  input(id: string, data: string): void {
    const channel = this.sessions.get(id)?.channel
    if (channel !== null && channel !== undefined) channel.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const channel = this.sessions.get(id)?.channel
    if (channel === null || channel === undefined) return
    const c = clampDimension(cols, 2, 1000)
    const r = clampDimension(rows, 1, 500)
    // ssh2 的参数顺序是 (rows, cols, height, width)，容易写反。
    channel.setWindow(r, c, 0, 0)
  }

  // ---------------------------------------------------------------- 元数据

  rename(id: string, title: string): TerminalView {
    const session = this.require(id)
    session.title = title.trim() === '' ? session.title : title.trim()
    this.persistRecent()
    this.broadcast(session)
    return viewOf(session)
  }

  setKeepAlive(id: string, keepAlive: boolean): TerminalView {
    const session = this.require(id)
    session.keepAlive = keepAlive
    this.broadcast(session)
    return viewOf(session)
  }

  list(): TerminalView[] {
    return [...this.sessions.values()].map(viewOf)
  }

  get(id: string): TerminalView | undefined {
    const session = this.sessions.get(id)
    return session === undefined ? undefined : viewOf(session)
  }

  /** 上次运行时打开、本次尚未重开的终端。 */
  listRecent(): RecentTerminal[] {
    return this.recent
  }

  clearRecent(): void {
    this.recent = []
  }

  /** 某主机被删除或配置变更时，关闭它的全部终端。 */
  closeHost(hostId: string): number {
    let count = 0
    for (const session of [...this.sessions.values()]) {
      if (session.hostId === hostId && this.close(session.id)) count += 1
    }
    return count
  }

  private require(id: string): Session {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`终端不存在：${id}`)
    return session
  }

  private broadcast(session: Session): void {
    const message: TerminalControl = { t: 'status', terminal: viewOf(session) }
    for (const viewer of session.viewers) safeCall(() => viewer.control(message))
  }

  // ---------------------------------------------------------------- 回收

  /** 回收长时间无人查看、且未标记后台保留的终端。 */
  reap(): number {
    const ttl = this.options.detachedTtlMs
    if (ttl <= 0) return 0
    let count = 0
    const now = this.now()
    for (const session of [...this.sessions.values()]) {
      if (session.keepAlive || session.viewers.size > 0 || session.detachedAt === undefined) continue
      if (now - session.detachedAt < ttl) continue
      this.log.info(
        session.hostId,
        'terminal',
        `终端「${session.title}」无人查看已超过 ${Math.round(ttl / 60_000)} 分钟，已自动回收。`
      )
      this.close(session.id)
      count += 1
    }
    return count
  }

  // ---------------------------------------------------------------- 持久化

  /**
   * 记录「当前打开着的终端」，供下次启动时一键重开。
   * 只记主机与标题等元数据，绝不记录输出内容（可能含敏感信息）。
   */
  private persistRecent(): void {
    const file = this.options.recentFile
    if (file === undefined || this.disposed) return
    const entries: RecentTerminal[] = [...this.sessions.values()]
      .filter((s) => s.status !== 'exited')
      .map((s) => ({ hostId: s.hostId, title: s.title, ...(s.cwd !== undefined ? { cwd: s.cwd } : {}) }))
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, terminals: entries }, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      // 记录失败只影响「下次重开」这个便利功能，不能让终端本身失败，但要留痕。
      this.log.warn('', 'terminal', '保存终端列表失败。', error instanceof Error ? error.message : String(error))
    }
  }

  private loadRecent(): RecentTerminal[] {
    const file = this.options.recentFile
    if (file === undefined || !existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { terminals?: unknown }
      if (!Array.isArray(parsed.terminals)) return []
      return parsed.terminals.filter(
        (t): t is RecentTerminal =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as RecentTerminal).hostId === 'string' &&
          typeof (t as RecentTerminal).title === 'string'
      )
    } catch {
      return []
    }
  }

  /**
   * 释放全部终端。插件卸载时调用。
   * 刻意不在这里写「最近终端」文件：卸载时全部关闭，写进去就是空列表，
   * 下次启动便无从重开 —— 这恰恰是该功能要覆盖的场景。
   */
  dispose(): void {
    this.disposed = true
    if (this.reaper !== undefined) clearInterval(this.reaper)
    for (const session of this.sessions.values()) {
      if (session.channel !== null) safeClose(session.channel)
    }
    this.sessions.clear()
  }
}

function viewOf(session: Session): TerminalView {
  return {
    id: session.id,
    hostId: session.hostId,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.reason !== undefined ? { reason: session.reason } : {}),
    keepAlive: session.keepAlive,
    viewers: session.viewers.size
  }
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function safeClose(channel: ShellChannel): void {
  try {
    channel.close()
  } catch {
    /* 已断开的通道重复关闭属正常 */
  }
}

/** 单个视图出错（如 socket 已断）不能影响其他视图或终端本身。 */
function safeCall(fn: () => void): void {
  try {
    fn()
  } catch {
    /* 视图自身的问题 */
  }
}
