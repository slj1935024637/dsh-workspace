/*
 * @Description: 主机指纹 TOFU 校验 —— 首次接受并记录，变更则拒绝
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/hostkey.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { KnownHostKey } from '../types.js'
import { knownHostsFile } from '../paths.js'

/**
 * 指纹变更时抛出。
 *
 * 不做 host key 校验等于每次连接都可能被中间人劫持而毫无察觉，
 * 所以这里采取 ssh 客户端的默认行为（TOFU）：首次记录，之后变更一律拒绝，
 * 由用户显式确认后才更新。
 */
export class HostKeyChangedError extends Error {
  readonly code = 'host_key_changed'
  constructor(
    readonly endpoint: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      [
        `主机指纹已变更：${endpoint}`,
        `  已记录：${expected}`,
        `  本次为：${actual}`,
        '',
        '这可能意味着服务器重装了系统，也可能是中间人攻击。',
        '确认变更属实后，请在主机管理页面点击「信任新指纹」。'
      ].join('\n')
    )
    this.name = 'HostKeyChangedError'
  }
}

interface KnownHostsShape {
  version: 1
  keys: Record<string, KnownHostKey>
}

/** 已知主机指纹库。落盘在 ~/.dsh/workspaces/known-hosts.json。 */
export class KnownHosts {
  private data: KnownHostsShape = { version: 1, keys: {} }
  private loaded = false

  private load(): void {
    if (this.loaded) return
    const file = knownHostsFile()
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as KnownHostsShape
        this.data = { version: 1, keys: parsed.keys ?? {} }
      } catch {
        // 指纹库损坏时退化为空库：这会让所有主机重新走 TOFU 首次记录流程，
        // 比直接拒绝所有连接更可用，且安全性退化是可感知的（用户会看到重新记录）。
        this.data = { version: 1, keys: {} }
      }
    }
    this.loaded = true
  }

  private persist(): void {
    const file = knownHostsFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  /**
   * 校验一个指纹。
   *
   * @returns 'trusted' 已记录且一致；'recorded' 首次见到，已记录
   * @throws HostKeyChangedError 已记录但不一致
   */
  verify(hostname: string, port: number, keyType: string, key: Buffer): 'trusted' | 'recorded' {
    this.load()
    const endpoint = `${hostname}:${port}`
    const fingerprint = fingerprintOf(key)
    const known = this.data.keys[endpoint]

    if (known === undefined) {
      this.data.keys[endpoint] = {
        endpoint,
        keyType,
        fingerprint,
        addedAt: new Date().toISOString()
      }
      this.persist()
      return 'recorded'
    }

    if (known.fingerprint !== fingerprint) {
      throw new HostKeyChangedError(endpoint, known.fingerprint, fingerprint)
    }
    return 'trusted'
  }

  /** 用户显式确认后，强制更新某个端点的指纹。 */
  trust(hostname: string, port: number, keyType: string, key: Buffer): void {
    this.load()
    const endpoint = `${hostname}:${port}`
    this.data.keys[endpoint] = {
      endpoint,
      keyType,
      fingerprint: fingerprintOf(key),
      addedAt: new Date().toISOString()
    }
    this.persist()
  }

  /** 移除记录（下次连接会重新走 TOFU）。 */
  forget(hostname: string, port: number): void {
    this.load()
    delete this.data.keys[`${hostname}:${port}`]
    this.persist()
  }

  list(): KnownHostKey[] {
    this.load()
    return Object.values(this.data.keys)
  }
}

/** 与 OpenSSH 一致的 SHA256 指纹表示（base64，去掉末尾填充）。 */
export function fingerprintOf(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}
