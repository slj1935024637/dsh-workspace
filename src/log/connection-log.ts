/*
 * @Description: 连接日志 —— 失败必须逐条可见，禁止静默吞掉
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/log/connection-log.ts
 */
import { randomUUID } from 'node:crypto'
import type { ConnectionLogEntry } from '../types.js'

/**
 * 环形连接日志。
 *
 * 存在的理由：dsh-remote 把单文件失败一律 `catch {}` 吞掉，
 * 用户看到的只是「同步完成」但文件不全，无从排查。
 * 这里所有失败都必须留痕，且可在 UI 上按主机查看。
 */
export class ConnectionLog {
  private entries: ConnectionLogEntry[] = []
  private listeners = new Set<(entry: ConnectionLogEntry) => void>()

  constructor(private readonly capacity = 500) {}

  /** 追加一条日志并通知订阅者。 */
  append(
    hostId: string,
    level: ConnectionLogEntry['level'],
    stage: string,
    message: string,
    detail?: string
  ): ConnectionLogEntry {
    const entry: ConnectionLogEntry = {
      id: randomUUID(),
      hostId,
      at: new Date().toISOString(),
      level,
      stage,
      message,
      ...(detail !== undefined ? { detail } : {})
    }
    this.entries.push(entry)
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
    for (const listener of this.listeners) {
      // 监听器抛错不能影响日志写入本身。
      try {
        listener(entry)
      } catch {
        /* 订阅者自身的问题，不回灌到日志链路 */
      }
    }
    return entry
  }

  info(hostId: string, stage: string, message: string, detail?: string): void {
    this.append(hostId, 'info', stage, message, detail)
  }

  warn(hostId: string, stage: string, message: string, detail?: string): void {
    this.append(hostId, 'warn', stage, message, detail)
  }

  /** 记录错误。error 可以是任意抛出物，统一提取 message 与 stack。 */
  error(hostId: string, stage: string, message: string, cause?: unknown): void {
    const detail =
      cause instanceof Error
        ? `${cause.message}\n${cause.stack ?? ''}`.trim()
        : cause === undefined
          ? undefined
          : String(cause)
    this.append(hostId, 'error', stage, message, detail)
  }

  /** 列出日志，可按主机过滤，最新在前。 */
  list(hostId?: string, limit = 200): ConnectionLogEntry[] {
    const filtered =
      hostId === undefined ? this.entries : this.entries.filter((e) => e.hostId === hostId)
    return filtered.slice(-limit).reverse()
  }

  /** 清空日志（可按主机）。 */
  clear(hostId?: string): void {
    this.entries =
      hostId === undefined ? [] : this.entries.filter((entry) => entry.hostId !== hostId)
  }

  /** 订阅新日志，返回取消订阅函数。 */
  subscribe(listener: (entry: ConnectionLogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
