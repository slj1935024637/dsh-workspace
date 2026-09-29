/*
 * @Description: 远程 HTML 预览路由 —— 经 SFTP 读取远程文件，相对资源（./style.css）自动可用
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/preview-route.ts
 *
 *   GET /dsh-workspace/preview/<令牌>/<逐段编码的远程绝对路径>
 *
 * 为什么用路径里的令牌、而不是靠请求来源判断：预览页在沙箱 iframe 里（不同源），它发出的
 * 样式 / 脚本请求在浏览器看来是跨站（Sec-Fetch-Site: cross-site），按来源判断会把自己的样式挡掉
 * （better-sidebar 的 HTML 预览加载不出样式，这是原因之一）。
 * 令牌由已认证的远程调用签发，只绑定「一台主机 + 一个远程工作区根目录」，页面里的相对路径
 * 自然带着同一个令牌；外部网页猜不到令牌，也就读不到任何文件。宿主名校验（防 DNS 重绑定）照常保留。
 *
 * 所有响应带 CSP sandbox（无 allow-same-origin）：即便有人把预览地址当顶层页面打开，
 * 它也处在不透明源里，碰不到 DSH 界面的接口与会话。
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import { isTrustedRequest } from './terminal/trust-fence.js'

/** 不带结尾斜杠（宿主前缀匹配规则见 contract.ts 的 SFTP_HTTP_PREFIX）。 */
export const PREVIEW_PREFIX = '/dsh-workspace/preview'

/** 预览单文件上限。 */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  wasm: 'application/wasm',
  pdf: 'application/pdf'
}

export function mimeOf(file: string): string {
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

interface Grant {
  hostId: string
  /** 允许访问的远程根目录（工作区根）。 */
  root: string
}

/** 令牌表：进程内存里，插件重载即全部失效。同一主机 + 根目录复用同一个令牌。 */
export class PreviewGrants {
  private byToken = new Map<string, Grant>()

  grant(hostId: string, root: string): string {
    for (const [token, g] of this.byToken) if (g.hostId === hostId && g.root === root) return token
    const token = randomBytes(18).toString('base64url')
    this.byToken.set(token, { hostId, root })
    return token
  }

  get(token: string): Grant | undefined {
    return this.byToken.get(token)
  }

  clear(): void {
    this.byToken.clear()
  }
}

/** 远程路径 → 预览地址（逐段编码，保持相对资源可解析）。 */
export function previewUrl(token: string, remotePath: string): string {
  return `${PREVIEW_PREFIX}/${token}${remotePath.split('/').map((s) => encodeURIComponent(s)).join('/')}`
}

/** 解析请求路径；非法返回 undefined。 */
export function parsePreviewPath(pathname: string): { token: string; remotePath: string } | undefined {
  if (!pathname.startsWith(`${PREVIEW_PREFIX}/`)) return undefined
  const rest = pathname.slice(PREVIEW_PREFIX.length + 1)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const token = rest.slice(0, slash)
  let segments: string[]
  try {
    segments = rest.slice(slash + 1).split('/').map((s) => decodeURIComponent(s))
  } catch {
    return undefined
  }
  // 解码后不允许出现路径分隔符或 NUL（防止 %2F 之类绕过逐段校验）。
  if (segments.some((s) => s.includes('/') || s.includes('\0'))) return undefined
  const remotePath = posix.normalize(`/${segments.join('/')}`)
  return { token, remotePath }
}

/** 远程路径是否在根目录内（折叠 .. 之后判断）。 */
export function insideRoot(root: string, remotePath: string): boolean {
  const r = root.replace(/\/+$/, '') || '/'
  return r === '/' || remotePath === r || remotePath.startsWith(`${r}/`)
}

export interface PreviewDeps {
  grants: PreviewGrants
  trustedHosts: () => readonly string[]
  /** 打开远程文件读取流（只允许普通文件）。 */
  open(hostId: string, remotePath: string): Promise<{ stream: Readable; size: number }>
}

export function createPreviewHandler(deps: PreviewDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 只校验宿主名（防 DNS 重绑定），不校验来源：见文件头说明。
    if (!isTrustedRequest({ headers: { host: req.headers.host } } as never, deps.trustedHosts())) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const parsed = parsePreviewPath(new URL(req.url ?? '/', 'http://x').pathname)
    const grant = parsed === undefined ? undefined : deps.grants.get(parsed.token)
    if (parsed === undefined || grant === undefined || !insideRoot(grant.root, parsed.remotePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    let opened: { stream: Readable; size: number }
    try {
      opened = await deps.open(grant.hostId, parsed.remotePath)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    if (opened.size > MAX_PREVIEW_BYTES) {
      opened.stream.destroy()
      res.writeHead(413).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': mimeOf(parsed.remotePath),
      'Content-Length': opened.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; object-src 'none'"
    })
    if (req.method === 'HEAD') {
      opened.stream.destroy()
      res.end()
      return
    }
    opened.stream.on('error', () => res.destroy())
    opened.stream.pipe(res)
  }
}
