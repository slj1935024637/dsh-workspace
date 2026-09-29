/*
 * @Description: 浏览器信任围栏 —— 与宿主 /api 网关行为一致的 DNS 重绑定 / 跨站防护
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/terminal/trust-fence.ts
 *
 * 逻辑与 dsh-better-sidebar 的 src/trust-fence.ts 相同，后者注明其源自
 * @deepseek-ai/dsh-client-connection（src/api-request-trust.ts + loopback-hostname.ts，
 * BSD-3-Clause）。宿主包未导出这些辅助函数，插件不应依赖其内部实现，故在此复刻。
 *
 * 注意：这是 DNS 重绑定 / 跨站防护，不是身份认证。DSH 的安全模型是
 * 「只有本机回环或显式信任的主机能访问服务端」，终端 socket 必须处在同一道围栏之后 ——
 * 一个没有围栏的终端 WebSocket 等于把远端 shell 交给任何能访问该端口的人。
 */

interface TrustRequest {
  headers: Record<string, string | string[] | undefined>
}

function header(headers: TrustRequest['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 主机名是否指向本机回环。 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 判断一个请求能否进入插件路由。
 * @param trustedHosts 本部署服务的非回环地址（宿主 webRuntime 提供，每次请求现读）。
 */
export function isTrustedRequest(request: TrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // 浏览器带了 Origin 就必须与 Host 同一主机名。比较 hostname 而非 host：
  // 部分 Chromium 版本对非默认端口的回环页面序列化 Origin 时不带端口。
  // 字面量 "null"（沙箱 iframe、file: 页面）是不透明来源，拒绝。
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
