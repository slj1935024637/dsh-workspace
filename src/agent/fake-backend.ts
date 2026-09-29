/*
 * @Description: 测试用内存后端（远程文件系统 + 可编排的命令输出）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/fake-backend.ts
 */
import type { AgentBackend, RemoteStat, RunOptions, RunResult } from './backend.js'

export class FakeBackend implements AgentBackend {
  files = new Map<string, { content: Buffer; mtimeMs: number }>()
  dirs = new Set<string>(['/'])
  commands: Array<{ command: string; options: RunOptions }> = []
  /** 按命令内容返回的结果；未命中时返回空输出、退出码 0。 */
  responder: (command: string, options: RunOptions) => Partial<RunResult> = () => ({})
  private clock = 1_700_000_000_000

  addDir(p: string): void {
    let cur = ''
    for (const part of p.split('/').filter(Boolean)) {
      cur = `${cur}/${part}`
      this.dirs.add(cur)
    }
  }

  put(p: string, content: string | Buffer): void {
    this.addDir(p.slice(0, p.lastIndexOf('/')) || '/')
    this.clock += 1000
    this.files.set(p, { content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), mtimeMs: this.clock })
  }

  text(p: string): string | undefined {
    return this.files.get(p)?.content.toString('utf8')
  }

  async stat(p: string): Promise<RemoteStat | undefined> {
    const f = this.files.get(p)
    if (f !== undefined) return { type: 'file', size: f.content.length, mtimeMs: f.mtimeMs }
    if (this.dirs.has(p)) return { type: 'dir', size: 0, mtimeMs: 0 }
    return undefined
  }

  async readBytes(p: string, maxBytes: number): Promise<Buffer> {
    const f = this.files.get(p)
    if (f === undefined) throw new Error(`no such file ${p}`)
    if (f.content.length > maxBytes) throw new Error('too large')
    return f.content
  }

  async writeText(p: string, content: string): Promise<void> {
    this.put(p, content)
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    this.commands.push({ command, options })
    return {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      code: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      ...this.responder(command, options)
    }
  }
}
