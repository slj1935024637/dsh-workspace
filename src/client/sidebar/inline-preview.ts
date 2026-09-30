/*
 * @Description: 桌面版预览 —— 把 HTML 里的相对资源（样式 / 脚本 / 图片 / CSS url()）经远程调用取回并内联，供 srcdoc 使用
 * @Author: YangHeng
 * @Date: 2026-09-30 11:40:00
 * @FilePath: /dsh-workspace/src/client/sidebar/inline-preview.ts
 *
 * 为什么需要：DSH 桌面版的本机 Web 服务只放行「DSH 自己页面来源」发出的请求（Electron 给这类请求附上
 * x-dsh-desktop-renderer 令牌），「允许浏览器访问」关闭时其余请求一律拒绝（macOS 上看到的 Browser access is disabled）。
 * 预览 iframe 刻意不带 allow-same-origin（远程 HTML 不可信，不能让它碰到 DSH 界面），它的来源是不透明的 null，
 * 请求拿不到令牌 —— 所以桌面版不能再让 iframe 去请求预览路由，改为 srcdoc + 内联。
 *
 * 取舍：只处理静态引用（link 样式表 / script src / img·source·video·audio src / 图标 / CSS url() 与 @import）；
 * 脚本运行时的 fetch / XHR / 动态 import 仍拿不到相对资源。用字符串改写而不是 DOMParser，便于在 Node 里单测。
 */

/** 读取远程文件（base64）；失败或超限返回 undefined，保留原引用。 */
export type DataReader = (remotePath: string) => Promise<string | undefined>

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav'
}

export function mimeOf(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

/** 需要改写的相对引用：不带协议、不是 // 协议相对、不是锚点。 */
export function isRelativeRef(ref: string): boolean {
  const r = ref.trim()
  return r !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r)
}

/** 相对引用 → 远程绝对路径（去掉 ?query 与 #hash）。/ 开头按工作区根处理（静态站点的根即工作区根）。 */
export function resolveRef(ref: string, dir: string, root: string): string {
  const clean = ref.trim().replace(/[?#].*$/, '')
  let decoded = clean
  try {
    decoded = decodeURI(clean)
  } catch {
    /* 非法转义：按原样 */
  }
  const joined = decoded.startsWith('/') ? `${root}/${decoded}` : `${dir}/${decoded}`
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function decodeUtf8(base64: string): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

function encodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** 没能内联的资源（预览里显示出来，而不是静默缺样式）。 */
export interface InlineFailure {
  path: string
  message: string
}

/**
 * 组合读取器：先按字节读（sftpReadData）；失败时文本资源退回按文本读（sftpRead）。
 * 为什么要退回：插件宿主端是旧版本时（macOS 上只关窗口不退出 DSH，宿主进程一直是旧的）新方法 404，
 * 而 sftpRead 一直都有 —— 样式表、脚本照样能内联，页面不至于整页丢样式。
 * 两条都失败的记进 failures。
 */
export function fallbackReader(
  readData: (remotePath: string) => Promise<string>,
  readText: (remotePath: string) => Promise<{ content: string; binary: boolean; truncated: boolean }>,
  failures: InlineFailure[]
): DataReader {
  return async (p) => {
    try {
      return await readData(p)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/^(?:text|application)\/(?:css|javascript|json)$/.test(mimeOf(p)) || mimeOf(p) === 'image/svg+xml') {
        try {
          const r = await readText(p)
          if (!r.binary && !r.truncated) return encodeUtf8(r.content)
        } catch {
          /* 按原始错误记录 */
        }
      }
      failures.push({ path: p, message })
      return undefined
    }
  }
}

/** 带缓存的读取：同一资源在页面里多次引用只取一次。 */
function cached(read: DataReader): DataReader {
  const cache = new Map<string, Promise<string | undefined>>()
  return (p) => {
    let hit = cache.get(p)
    if (hit === undefined) {
      hit = read(p).catch(() => undefined)
      cache.set(p, hit)
    }
    return hit
  }
}

/** 字符串的异步替换（按出现顺序并发取资源）。 */
async function replaceAsync(text: string, re: RegExp, fn: (...m: string[]) => Promise<string>): Promise<string> {
  const jobs: Array<Promise<string>> = []
  text.replace(re, (...m: unknown[]) => {
    jobs.push(fn(...(m.filter((x) => typeof x === 'string') as string[])))
    return ''
  })
  const results = await Promise.all(jobs)
  let i = 0
  return text.replace(re, () => results[i++] as string)
}

/** CSS 里的 url(...) 与 @import：相对 cssDir 解析，图片 / 字体转 data URL，@import 的样式递归内联。 */
async function inlineCss(css: string, cssDir: string, root: string, read: DataReader, depth: number): Promise<string> {
  let out = await replaceAsync(css, /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi, async (whole, _q, ref, media) => {
    if (depth > 3 || ref === undefined || !isRelativeRef(ref)) return whole
    const target = resolveRef(ref, cssDir, root)
    const data = await read(target)
    if (data === undefined) return whole
    const inner = await inlineCss(decodeUtf8(data), dirOf(target), root, read, depth + 1)
    return media !== undefined && media.trim() !== '' ? `@media ${media.trim()} {\n${inner}\n}` : inner
  })
  out = await replaceAsync(out, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (whole, _q, ref) => {
    if (ref === undefined || !isRelativeRef(ref)) return whole
    const target = resolveRef(ref, cssDir, root)
    const data = await read(target)
    return data === undefined ? whole : `url("data:${mimeOf(target)};base64,${data}")`
  })
  return out
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m === null ? undefined : (m[1] ?? m[2] ?? m[3])
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i')
  return tag.replace(re, `$1"${value.replace(/"/g, '&quot;')}"`)
}

/**
 * 内联 HTML 里的相对资源。
 * @param html 页面源码
 * @param filePath 页面所在的远程绝对路径（相对引用以它的目录为基准）
 * @param root 远程工作区根（/ 开头的引用以它为基准）
 */
export async function inlineHtml(html: string, filePath: string, root: string, reader: DataReader): Promise<string> {
  const read = cached(reader)
  const dir = dirOf(filePath)

  // 1. 外链样式表 → <style>
  let out = await replaceAsync(html, /<link\b[^>]*>/gi, async (tag) => {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase()
    const href = attr(tag, 'href')
    if (href === undefined || !isRelativeRef(href)) return tag
    const target = resolveRef(href, dir, root)
    const data = await read(target)
    if (data === undefined) return tag
    if (rel.split(/\s+/).includes('stylesheet')) {
      const media = attr(tag, 'media')
      const css = await inlineCss(decodeUtf8(data), dirOf(target), root, read, 0)
      return `<style data-dshws-href="${href.replace(/"/g, '&quot;')}"${media !== undefined ? ` media="${media}"` : ''}>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`
    }
    // 图标、预加载图片等：改成 data URL
    return setAttr(tag, 'href', `data:${mimeOf(target)};base64,${data}`)
  })

  // 2. 外链脚本 → 内联脚本（保留 type 等属性）
  out = await replaceAsync(out, /<script\b([^>]*)>\s*<\/script>/gi, async (whole, attrs) => {
    const src = attr(` ${attrs ?? ''}`, 'src')
    if (src === undefined || !isRelativeRef(src)) return whole
    const target = resolveRef(src, dir, root)
    const data = await read(target)
    if (data === undefined) return whole
    const rest = (attrs ?? '').replace(/\s(?:src|integrity|crossorigin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    return `<script${rest} data-dshws-src="${src.replace(/"/g, '&quot;')}">\n${decodeUtf8(data).replace(/<\/script/gi, '<\\/script')}\n</script>`
  })

  // 3. 媒体 src → data URL
  out = await replaceAsync(out, /<(?:img|source|video|audio|input)\b[^>]*>/gi, async (tag) => {
    const src = attr(tag, 'src')
    if (src === undefined || !isRelativeRef(src)) return tag
    const target = resolveRef(src, dir, root)
    const data = await read(target)
    return data === undefined ? tag : setAttr(tag, 'src', `data:${mimeOf(target)};base64,${data}`)
  })

  // 4. 页面内 <style> 与 style="" 里的 url()
  out = await replaceAsync(out, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (_w, open, css, close) =>
    `${open ?? ''}${await inlineCss(css ?? '', dir, root, read, 0)}${close ?? ''}`
  )
  out = await replaceAsync(out, /\sstyle\s*=\s*"([^"]*url\([^"]*)"/gi, async (_w, css) => ` style="${(await inlineCss((css ?? '').replace(/&quot;/g, '"'), dir, root, read, 0)).replace(/"/g, '&quot;')}"`)
  return out
}
