/*
 * @Description: 原子写的最后一步（临时文件改名覆盖目标）—— Windows 上对杀毒 / 索引占用做短暂重试
 * @Author: YangHeng
 * @Date: 2026-09-30 11:50:00
 * @FilePath: /dsh-workspace/src/fs-atomic.ts
 *
 * Windows 的 rename 覆盖在目标文件被杀毒软件、搜索索引、同步盘短暂打开时会报 EPERM / EACCES / EBUSY，
 * 通常几十到几百毫秒后自行释放（graceful-fs 的做法同理）。不重试的话保存保险箱会直接失败，还会残留 *.tmp。
 * macOS / Linux 的 rename 是原子替换，不会遇到这类占用，不重试。
 */
import { renameSync, rmSync } from 'node:fs'

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** 退避间隔（毫秒），合计约 0.6 秒。 */
const BACKOFF_MS = [20, 40, 80, 120, 160, 200]

/** 同步睡眠：调用方都是同步的持久化函数，不值得为此改成异步。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 把 tmp 改名为 target。失败（含重试用尽）时删掉 tmp 再抛出，不留垃圾文件。
 * @param platform 测试用
 * @param rename 测试用
 */
export function renameWithRetry(tmp: string, target: string, platform: NodeJS.Platform = process.platform, rename: (a: string, b: string) => void = renameSync): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, target)
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const retry = platform === 'win32' && typeof code === 'string' && RETRYABLE.has(code) && attempt < BACKOFF_MS.length
      if (retry) {
        sleepSync(BACKOFF_MS[attempt] as number)
        continue
      }
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw error
    }
  }
}
