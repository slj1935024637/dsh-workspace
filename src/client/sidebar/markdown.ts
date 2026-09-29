/*
 * @Description: Markdown → 预览页面（放进无脚本沙箱 iframe 的 srcdoc）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/markdown.ts
 *
 * 安全：Markdown 里可以夹带任意 HTML。这里不做白名单清洗，而是让 iframe 本身不可执行脚本
 * （sandbox 不含 allow-scripts、不含 allow-same-origin）+ CSP 禁止脚本 —— 页面最多只能显示，
 * 碰不到 DSH 界面，也发不出脚本请求。
 * 相对图片（./img/a.png）经 <base> 指向远程预览路由，与 HTML 预览同一套令牌鉴权。
 */
import { marked } from 'marked'

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * @param markdown Markdown 原文
 * @param baseHref 该文件所在目录的预览地址（绝对 URL，以 / 结尾）；undefined 时相对图片不加载
 * @param dark 是否深色主题
 */
export function markdownDocument(markdown: string, baseHref: string | undefined, dark: boolean): string {
  const body = marked.parse(markdown, { gfm: true, breaks: false, async: false }) as string
  const imgSrc = baseHref === undefined ? 'data:' : `${new URL(baseHref).origin} data:`
  const fg = dark ? '#d4d4d4' : '#1f2328'
  const bg = dark ? '#1e1e1e' : '#ffffff'
  const border = dark ? '#3a3a3a' : '#d0d7de'
  const codeBg = dark ? '#2a2a2a' : '#f6f8fa'
  const link = dark ? '#4ea1ff' : '#0969da'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc} https:; style-src 'unsafe-inline'; font-src data:">
${baseHref === undefined ? '' : `<base href="${escapeAttr(baseHref)}">`}
<style>
  body { margin: 0; padding: 16px 20px 40px; color: ${fg}; background: ${bg};
    font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; word-wrap: break-word; }
  h1, h2 { border-bottom: 1px solid ${border}; padding-bottom: .3em; }
  h1, h2, h3, h4 { margin: 1.2em 0 .6em; line-height: 1.3; }
  a { color: ${link}; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 85%; background: ${codeBg}; padding: .15em .35em; border-radius: 4px; }
  pre { background: ${codeBg}; padding: 12px 14px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; font-size: 12.5px; }
  blockquote { margin: 0; padding: 0 1em; color: ${dark ? '#9da5b4' : '#59636e'}; border-left: 4px solid ${border}; }
  table { border-collapse: collapse; display: block; overflow: auto; }
  th, td { border: 1px solid ${border}; padding: 6px 12px; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid ${border}; }
  ul.contains-task-list { padding-left: 1.2em; }
</style></head><body>${body}</body></html>`
}

/** 预览地址所在的目录（绝对 URL）：给 <base> 用。 */
export function directoryHref(previewUrl: string, origin: string): string {
  const abs = new URL(previewUrl, origin).href
  return abs.slice(0, abs.lastIndexOf('/') + 1)
}
