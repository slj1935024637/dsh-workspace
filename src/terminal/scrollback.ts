/*
 * @Description: 终端回滚缓冲 —— 按字节上限保留最近输出，新视图接入时整段回放
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/terminal/scrollback.ts
 */

/**
 * 以原始字节保存终端输出。
 *
 * 为什么存字节而不是存行：终端输出里混着 ANSI 转义序列、光标移动、覆盖重绘，
 * 「行」在服务端没有可靠定义。原样保存字节，回放时交给 xterm 重新解释，
 * 效果与用户当时看到的一致。
 *
 * 裁剪时尽量从换行处切：从某个转义序列中间切开，回放开头会出现一小段乱码。
 */
export class Scrollback {
  private chunks: Buffer[] = []
  private size = 0

  constructor(private readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes 必须为正数')
  }

  /** 追加一段输出，超限时从头部裁剪。 */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size > this.maxBytes) this.trim()
  }

  private trim(): void {
    // 先整块丢弃，直到剩余不超过上限。
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const head = this.chunks.shift() as Buffer
      this.size -= head.length
    }
    if (this.size <= this.maxBytes) return

    // 只剩一块仍超限（单块巨量输出）：在块内裁剪，优先对齐到换行之后。
    const only = this.chunks[0] as Buffer
    let start = only.length - this.maxBytes
    const newline = only.indexOf(0x0a, start)
    // 在不丢失太多内容的前提下对齐换行（最多再多丢 1/8）。
    if (newline !== -1 && newline - start < this.maxBytes / 8) start = newline + 1
    const kept = only.subarray(start)
    this.chunks = [Buffer.from(kept)]
    this.size = kept.length
  }

  /** 当前全部内容（拼接为一块，用于回放）。 */
  snapshot(): Buffer {
    return this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks, this.size)
  }

  get byteLength(): number {
    return this.size
  }

  clear(): void {
    this.chunks = []
    this.size = 0
  }
}

/**
 * 由「行数上限」估算字节上限。
 * 平均每行按 200 字节估（含转义序列与宽字符），5000 行约 1MB。
 */
export function bytesForLines(lines: number): number {
  return Math.max(64 * 1024, lines * 200)
}
