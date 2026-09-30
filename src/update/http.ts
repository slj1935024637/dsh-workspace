/*
 * @Description: 离线安装包上传路由（与文件传输同一道信任围栏）
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/update/http.ts
 *
 *   POST /dsh-workspace/update/upload   请求体 = .tgz 原始字节
 *   → 200 { ok: true, upload: UploadView }（只检查、不安装；界面确认后再调 updateInstall）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { isTrustedRequest } from '../terminal/trust-fence.js'
import { ERROR_CODES, UPDATE_HTTP_PREFIX } from '../wire/contract.js'
import type { ConnectionLog } from '../log/connection-log.js'
import { MAX_PACKAGE_BYTES } from './source.js'
import type { Updater } from './updater.js'

export { UPDATE_HTTP_PREFIX }

export interface UpdateHttpDeps {
  updater: Updater
  dir: string
  log: ConnectionLog
  trustedHosts: () => readonly string[]
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

class TooLargeError extends Error {}

export function createUpdateHttpHandler(deps: UpdateHttpDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrustedRequest(req as never, deps.trustedHosts())) {
      deps.log.warn('', 'update', '拒绝了一次不受信任的安装包上传请求。', `host=${String(req.headers.host ?? '')} origin=${String(req.headers.origin ?? '')}`)
      return send(res, 403, { code: 'dsh-workspace/forbidden', message: 'forbidden' })
    }
    // 与文件传输路由一致：只回显已通过信任围栏的 Origin（桌面版页面来源可能与宿主端口不同）。
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (origin !== undefined && origin !== 'null') {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const action = new URL(req.url ?? '/', 'http://x').pathname.slice(UPDATE_HTTP_PREFIX.length + 1)
    if (action !== 'upload' || req.method !== 'POST') {
      return send(res, 405, { code: 'dsh-workspace/bad-request', message: 'unsupported method or action' })
    }
    const declared = Number(req.headers['content-length'] ?? 'NaN')
    if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) {
      req.resume()
      return send(res, 413, { code: 'dsh-workspace/too-large', message: '安装包超过 50MB 上限。' })
    }
    await mkdir(deps.dir, { recursive: true })
    const temp = path.join(deps.dir, `upload-${randomUUID()}.part`)
    let seen = 0
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length
        if (seen > MAX_PACKAGE_BYTES) cb(new TooLargeError('安装包超过 50MB 上限。'))
        else cb(null, chunk)
      }
    })
    try {
      await pipeline(req, limit, createWriteStream(temp))
    } catch (error) {
      await rm(temp, { force: true })
      req.resume()
      if (error instanceof TooLargeError) return send(res, 413, { code: 'dsh-workspace/too-large', message: error.message })
      return send(res, 400, { code: ERROR_CODES.failed, message: `上传中断：${error instanceof Error ? error.message : String(error)}` })
    }
    try {
      const upload = await deps.updater.acceptUpload(temp)
      send(res, 200, { ok: true, upload })
    } catch (error) {
      send(res, 400, { code: ERROR_CODES.failed, message: error instanceof Error ? error.message : String(error) })
    }
  }
}
