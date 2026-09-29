/*
 * @Description: 改动前原内容（pre-image）存档 —— 远程写入的审查与回退依据
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/preimages.ts
 *
 * DSH 自带的改动记录只认本机文件，远程 write / edit 在那里会被记错（方案已确认：不依赖它）。
 * 这里在每个会话里、对每个远程文件记录「本会话第一次改它之前」的内容：
 * 同一文件后续再改不覆盖基线，回退时一步回到会话开始前的状态。
 *
 * 布局：<插件根>/preimages/<会话 id>/index.json + <sha256>.txt（内容按哈希去重）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pluginRoot, safeSegment } from '../paths.js'

export interface PreimageEntry {
  hostId: string
  path: string
  /** 改动前文件不存在（本会话新建的文件）。 */
  absent: boolean
  /** 原内容的 sha256；absent 或内容过大时为 null。 */
  sha256: string | null
  size: number
  /** 超过存档上限，只记下「改过」，无法回退内容。 */
  tooLarge: boolean
  tool: string
  capturedAt: string
}

/** 单个文件原内容的存档上限。 */
export const PREIMAGE_MAX_BYTES = 4 * 1024 * 1024

export class PreimageStore {
  constructor(private readonly root: () => string = () => path.join(pluginRoot(), 'preimages')) {}

  private dirOf(sessionId: string): string {
    return path.join(this.root(), safeSegment(sessionId))
  }

  list(sessionId: string): PreimageEntry[] {
    const index = path.join(this.dirOf(sessionId), 'index.json')
    if (!existsSync(index)) return []
    try {
      const parsed = JSON.parse(readFileSync(index, 'utf8')) as { entries?: PreimageEntry[] }
      return Array.isArray(parsed.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  /** 已有基线就不再记录（只保留本会话第一次改动前的内容）。 */
  has(sessionId: string, hostId: string, remotePath: string): boolean {
    return this.list(sessionId).some((e) => e.hostId === hostId && e.path === remotePath)
  }

  /**
   * 记录基线。content 为 undefined 表示改动前文件不存在。
   * 失败不抛出：存档是增强能力，不能因为本地磁盘问题阻断 Agent 的正常写入。
   */
  capture(sessionId: string, entry: { hostId: string; path: string; tool: string }, content: Buffer | undefined): void {
    try {
      if (this.has(sessionId, entry.hostId, entry.path)) return
      const dir = this.dirOf(sessionId)
      mkdirSync(dir, { recursive: true })
      let sha256: string | null = null
      const tooLarge = content !== undefined && content.length > PREIMAGE_MAX_BYTES
      if (content !== undefined && !tooLarge) {
        sha256 = createHash('sha256').update(content).digest('hex')
        const blob = path.join(dir, `${sha256}.txt`)
        if (!existsSync(blob)) writeFileSync(blob, content)
      }
      const entries = this.list(sessionId)
      entries.push({
        hostId: entry.hostId,
        path: entry.path,
        absent: content === undefined,
        sha256,
        size: content?.length ?? 0,
        tooLarge,
        tool: entry.tool,
        capturedAt: new Date().toISOString()
      })
      const index = path.join(dir, 'index.json')
      const tmp = `${index}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2))
      renameSync(tmp, index)
    } catch {
      /* 见方法注释 */
    }
  }

  /** 取回原内容（回退用）。 */
  read(sessionId: string, sha256: string): Buffer | undefined {
    const blob = path.join(this.dirOf(sessionId), `${sha256}.txt`)
    return existsSync(blob) ? readFileSync(blob) : undefined
  }
}
