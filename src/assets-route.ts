/*
 * @Description: 静态资源路由 —— 提供按需加载的 Monaco 编辑器脚本
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/assets-route.ts
 *
 *   GET /dsh-workspace/assets/<白名单文件>
 *
 * 只认白名单里的文件名，不拼接任意路径，天然没有目录穿越。
 * 带 ETag，浏览器缓存后重复打开只有一次 304；客户端支持 gzip 时发预压缩的 .gz。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { isTrustedRequest } from './terminal/trust-fence.js'

/** 不带结尾斜杠，原因见 contract.ts 的 SFTP_HTTP_PREFIX。 */
export const ASSETS_PREFIX = '/dsh-workspace/assets'

const ALLOWED: Record<string, string> = {
  'monaco.js': 'text/javascript; charset=utf-8',
  'editor.worker.js': 'text/javascript; charset=utf-8'
}

export function createAssetsHandler(assetsDir: string, trustedHosts: () => readonly string[]) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrustedRequest(req as never, trustedHosts())) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(ASSETS_PREFIX.length + 1)
    const type = Object.hasOwn(ALLOWED, name) ? ALLOWED[name] : undefined
    const file = path.join(assetsDir, name)
    if (type === undefined || !existsSync(file)) {
      res.writeHead(404).end()
      return
    }

    const gzFile = `${file}.gz`
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const useGz = acceptsGzip && existsSync(gzFile)
    const served = useGz ? gzFile : file
    const stat = statSync(served)
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${useGz ? '-gz' : ''}"`

    const headers: Record<string, string | number> = {
      'Content-Type': type,
      ETag: etag,
      // 每次都向服务端确认（命中就是 304），插件升级后不会拿到旧脚本。
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff'
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end()
      return
    }
    headers['Content-Length'] = stat.size
    if (useGz) headers['Content-Encoding'] = 'gzip'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(served)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}
