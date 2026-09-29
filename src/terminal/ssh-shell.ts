/*
 * @Description: 基于连接池的远端 shell 打开器 —— 注入工作目录、环境变量、启动命令
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/terminal/ssh-shell.ts
 */
import type { WorkspaceRuntime } from '../runtime.js'
import type { OpenShellOptions, ShellChannel, ShellOpener } from './registry.js'

/** 环境变量名的合法形式（POSIX）。不合法的名字会被跳过并记日志，而不是拼进命令。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** POSIX shell 单引号转义：' → '\'' 。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 组装登录后自动执行的一行命令。
 *
 * 为什么把环境变量写成 export 而不是走 SSH 协议的 env 请求：
 * 协议层的 env 需要服务端 sshd_config 有匹配的 AcceptEnv，绝大多数服务器没配，
 * 会被静默丢弃 —— 用户配了变量却不生效，还无从得知。写成 export 一定生效。
 *
 * 行首加空格：bash 在 HISTCONTROL=ignorespace（多数发行版默认）下不记入历史。
 */
export function buildStartupLine(input: {
  env?: Record<string, string>
  cwd?: string
  startupCommand?: string
  onInvalidEnv?: (name: string) => void
}): string | undefined {
  const parts: string[] = []
  const env = Object.entries(input.env ?? {}).filter(([name]) => {
    if (ENV_NAME.test(name)) return true
    input.onInvalidEnv?.(name)
    return false
  })
  if (env.length > 0) {
    parts.push(`export ${env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}`)
  }
  if (input.cwd !== undefined && input.cwd.trim() !== '') {
    parts.push(`cd -- ${shellQuote(input.cwd)}`)
  }
  if (input.startupCommand !== undefined && input.startupCommand.trim() !== '') {
    parts.push(input.startupCommand.trim())
  }
  return parts.length === 0 ? undefined : ` ${parts.join('; ')}\n`
}

interface Ssh2ShellClient {
  shell(
    window: { rows: number; cols: number; height: number; width: number; term: string },
    options: Record<string, unknown>,
    callback: (err: Error | null | undefined, channel: ShellChannel) => void
  ): void
}

/** 创建基于运行时连接池的 shell 打开器。终端走「terminal」池，不与文件传输抢带宽。 */
export function createSshShellOpener(rt: WorkspaceRuntime): ShellOpener {
  return async (hostId: string, options: OpenShellOptions): Promise<ShellChannel> => {
    const target = rt.resolveHost(hostId)
    const connection = await rt.pool.acquire(hostId, 'terminal', () => rt.resolveHost(hostId))
    const client = connection.raw() as unknown as Ssh2ShellClient

    const channel = await new Promise<ShellChannel>((resolve, reject) => {
      client.shell(
        { rows: options.rows, cols: options.cols, height: 0, width: 0, term: 'xterm-256color' },
        {},
        (err, ch) => {
          if (err !== null && err !== undefined) {
            // OpenSSH 默认每条连接最多 10 个会话（MaxSessions），超出时这里失败。
            // 原始报错只有 "Channel open failure"，给用户补上可操作的解释。
            const hint = /open failure|channel/i.test(err.message)
              ? '（可能已达到服务器单连接会话数上限 MaxSessions，请关闭部分终端后重试）'
              : ''
            reject(new Error(`打开远端 shell 失败：${err.message}${hint}`, { cause: err }))
            return
          }
          resolve(ch)
        }
      )
    })

    const line = buildStartupLine({
      ...(target.environmentVariables !== undefined ? { env: target.environmentVariables } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(target.startupCommand !== undefined ? { startupCommand: target.startupCommand } : {}),
      onInvalidEnv: (name) =>
        rt.log.warn(hostId, 'terminal', `环境变量名不合法，已跳过：${name}`)
    })
    if (line !== undefined) channel.write(line)
    return channel
  }
}
