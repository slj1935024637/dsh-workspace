/*
 * @Description: 在远端执行一条命令并截取输出 —— 带超时与输出上限
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/exec.ts
 */
import type { SshConnection } from '../ssh/connection.js'

export interface ExecResult {
  stdout: string
  stderr: string
  /** 退出码；被超时或信号终止时为 null。 */
  code: number | null
  timedOut: boolean
  /** 输出超过上限被截断。 */
  truncated: boolean
}

export interface ExecOptions {
  timeoutMs: number
  /** stdout 保留的最大字节数，超出后丢弃并关闭通道。 */
  maxBytes: number
  /** 写入远端命令标准输入的内容（写完即关闭）；不传则不写。 */
  input?: Buffer | string
}

interface ExecStream {
  end?(data?: Buffer | string): unknown
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  close(): unknown
}

/**
 * 执行命令。超时或输出超限时主动关闭通道（远端会收到 SIGPIPE / 连接关闭），
 * 不让一条失控的 find 在远端一直跑下去。
 */
export function execCapture(connection: SshConnection, command: string, options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    connection.raw().exec(command, {}, (err, rawStream) => {
      if (err !== null && err !== undefined) {
        reject(err)
        return
      }
      const stream = rawStream as ExecStream
      // 例如 git hash-object --stdin：内容走标准输入，不必先落临时文件。
      if (options.input !== undefined) stream.end?.(options.input)
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let size = 0
      let timedOut = false
      let truncated = false
      let settled = false

      const timer = setTimeout(() => {
        timedOut = true
        safeClose(stream)
      }, options.timeoutMs)

      stream.on('data', (chunk: Buffer) => {
        if (truncated) return
        const room = options.maxBytes - size
        if (chunk.length >= room) {
          out.push(chunk.subarray(0, Math.max(0, room)))
          size = options.maxBytes
          truncated = true
          safeClose(stream)
          return
        }
        out.push(chunk)
        size += chunk.length
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        // stderr 只留一小段用于报错说明。
        if (errOut.reduce((n, b) => n + b.length, 0) < 8192) errOut.push(chunk)
      })
      stream.on('close', (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          code: timedOut || truncated ? null : code,
          timedOut,
          truncated
        })
      })
    })
  })
}

function safeClose(stream: ExecStream): void {
  try {
    stream.close()
  } catch {
    /* 已关闭 */
  }
}
