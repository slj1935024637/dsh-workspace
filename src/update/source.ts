/*
 * @Description: 最新版本查询与安装包下载 —— GitHub 直连，失败回退 npm 官方源
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/update/source.ts
 *
 * 查询顺序：
 *   ① GitHub API releases/latest（带资产 sha256 摘要与更新说明；未认证每小时 60 次）
 *   ② github.com/<repo>/releases/latest 的 302 跳转地址（不占 API 额度，但没有摘要与说明）
 *   ③ registry.npmjs.org（npmmirror 同步滞后，不用）
 * 下载同样按候选地址依次尝试：GitHub 资产不通时回退同版本的 npm tarball。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { PLUGIN_PACKAGE } from './tarball.js'

export const REPO = 'yh4922/dsh-workspace'
const NPM_REGISTRY = 'https://registry.npmjs.org'
const TIMEOUT_MS = 10_000
/** 下载整体超时：安装包 3MB 左右，慢速网络也足够。 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/** 下载大小上限：远超正常包体，防止被导到异常地址时写满磁盘。 */
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024

/** 一个可下载的安装包地址与其校验值。 */
export interface DownloadCandidate {
  url: string
  /** sha256 十六进制（GitHub 资产摘要）。 */
  sha256?: string
  /** npm 的 integrity（sha512-<base64>）。 */
  integrity?: string
}

export interface LatestRelease {
  version: string
  /** 查询来源，界面据此提示（例如 npm 来源没有更新说明）。 */
  source: 'github' | 'github-redirect' | 'npm'
  notes: string
  publishedAt?: string
  /** 发布页地址（给用户点开看完整说明）。 */
  pageUrl: string
  downloads: DownloadCandidate[]
}

type FetchLike = typeof fetch

const HEADERS = { 'User-Agent': 'dsh-workspace-updater', Accept: 'application/json' }

/** 带超时的 GET；非 2xx 抛错，错误信息带状态码，便于汇总展示。 */
async function getJson(fetchImpl: FetchLike, url: string, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { ...HEADERS, ...extraHeaders }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? '（可能触发了访问频率限制）' : ''
    throw new Error(`HTTP ${res.status}${hint}`)
  }
  return (await res.json()) as Record<string, unknown>
}

function versionOfTag(tag: string): string {
  return tag.replace(/^v/, '')
}

function versionedAsset(version: string): string {
  return `${PLUGIN_PACKAGE.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

/** npm 同版本 tarball 地址（固定规则，不用额外查询）。 */
export function npmTarballUrl(version: string): string {
  const bare = PLUGIN_PACKAGE.split('/')[1] as string
  return `${NPM_REGISTRY}/${PLUGIN_PACKAGE}/-/${bare}-${version}.tgz`
}

async function fromGithubApi(fetchImpl: FetchLike): Promise<LatestRelease> {
  const body = await getJson(fetchImpl, `https://api.github.com/repos/${REPO}/releases/latest`, { Accept: 'application/vnd.github+json' })
  const tag = typeof body.tag_name === 'string' ? body.tag_name : ''
  if (tag === '') throw new Error('返回内容缺少 tag_name')
  const version = versionOfTag(tag)
  const assets = Array.isArray(body.assets) ? (body.assets as Array<Record<string, unknown>>) : []
  const wanted = [versionedAsset(version), 'dsh-workspace.tgz']
  const downloads: DownloadCandidate[] = []
  for (const name of wanted) {
    const asset = assets.find((a) => a.name === name)
    if (asset === undefined || typeof asset.browser_download_url !== 'string') continue
    const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1] : undefined
    downloads.push({ url: asset.browser_download_url, ...(digest !== undefined ? { sha256: digest.toLowerCase() } : {}) })
    break
  }
  downloads.push({ url: npmTarballUrl(version) })
  return {
    version,
    source: 'github',
    notes: typeof body.body === 'string' ? body.body : '',
    ...(typeof body.published_at === 'string' ? { publishedAt: body.published_at } : {}),
    pageUrl: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${REPO}/releases/tag/${tag}`,
    downloads
  }
}

async function fromGithubRedirect(fetchImpl: FetchLike): Promise<LatestRelease> {
  const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, {
    headers: HEADERS,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const location = res.headers.get('location') ?? ''
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1]
  if (tag === undefined) throw new Error(`HTTP ${res.status}，未拿到跳转地址`)
  const decoded = decodeURIComponent(tag)
  const version = versionOfTag(decoded)
  return {
    version,
    source: 'github-redirect',
    notes: '',
    pageUrl: `https://github.com/${REPO}/releases/tag/${decoded}`,
    downloads: [
      { url: `https://github.com/${REPO}/releases/download/${decoded}/${versionedAsset(version)}` },
      { url: npmTarballUrl(version) }
    ]
  }
}

async function fromNpm(fetchImpl: FetchLike): Promise<LatestRelease> {
  const body = await getJson(fetchImpl, `${NPM_REGISTRY}/${PLUGIN_PACKAGE.replace('/', '%2f')}/latest`)
  const version = typeof body.version === 'string' ? body.version : ''
  if (version === '') throw new Error('返回内容缺少 version')
  const dist = (body.dist ?? {}) as { tarball?: unknown; integrity?: unknown }
  return {
    version,
    source: 'npm',
    notes: '',
    pageUrl: `https://github.com/${REPO}/releases/tag/v${version}`,
    downloads: [
      {
        url: typeof dist.tarball === 'string' ? dist.tarball : npmTarballUrl(version),
        ...(typeof dist.integrity === 'string' ? { integrity: dist.integrity } : {})
      }
    ]
  }
}

/** 依次查询三个来源，第一个成功的为准；全部失败时抛出汇总错误。 */
export async function fetchLatest(fetchImpl: FetchLike = fetch): Promise<LatestRelease> {
  const failures: string[] = []
  const attempts: Array<[string, (f: FetchLike) => Promise<LatestRelease>]> = [
    ['GitHub API', fromGithubApi],
    ['GitHub 发布页', fromGithubRedirect],
    ['npm 官方源', fromNpm]
  ]
  for (const [label, run] of attempts) {
    try {
      return await run(fetchImpl)
    } catch (error) {
      failures.push(`${label}：${describe(error)}`)
    }
  }
  throw new Error(`无法获取最新版本（${failures.join('；')}）`)
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '连接超时'
    const cause = (error as { cause?: { code?: unknown } }).cause
    return typeof cause?.code === 'string' ? `${error.message}（${cause.code}）` : error.message
  }
  return String(error)
}

/** 校验失败：不是网络问题，换下一个地址也不该静默通过，直接报出。 */
export class ChecksumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChecksumError'
  }
}

/**
 * 把一个候选地址下载到 dest（先写 .part，校验通过再改名）。
 * @param onProgress 已收字节 / 总字节（未知时为 undefined）
 */
export async function downloadTo(
  candidate: DownloadCandidate,
  dest: string,
  onProgress: (received: number, total: number | undefined) => void,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const res = await fetchImpl(candidate.url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 'NaN')
  const total = Number.isFinite(declared) ? declared : undefined
  if (total !== undefined && total > MAX_PACKAGE_BYTES) throw new Error('安装包大小异常（超过 50MB）')
  const part = `${dest}.part`
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  const out = createWriteStream(part)
  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > MAX_PACKAGE_BYTES) throw new Error('安装包大小异常（超过 50MB）')
      sha256.update(value)
      sha512.update(value)
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      onProgress(received, total)
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    if (candidate.sha256 !== undefined && sha256.digest('hex') !== candidate.sha256) {
      throw new ChecksumError('安装包 sha256 校验失败（与发布页记录不一致），已放弃安装。')
    }
    if (candidate.integrity !== undefined) {
      const [algo, expected] = candidate.integrity.split('-', 2)
      if (algo === 'sha512' && expected !== undefined && sha512.digest('base64') !== expected) {
        throw new ChecksumError('安装包 sha512 校验失败（与 npm 记录不一致），已放弃安装。')
      }
    }
    await rename(part, dest)
  } catch (error) {
    out.destroy()
    await rm(part, { force: true })
    throw error
  }
}

/** 依次尝试候选地址；校验失败不再换地址（说明内容被篡改或发布有误）。 */
export async function downloadAny(
  candidates: DownloadCandidate[],
  dest: string,
  onProgress: (received: number, total: number | undefined) => void,
  fetchImpl: FetchLike = fetch
): Promise<DownloadCandidate> {
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      await downloadTo(candidate, dest, onProgress, fetchImpl)
      return candidate
    } catch (error) {
      if (error instanceof ChecksumError) throw error
      failures.push(`${new URL(candidate.url).host}：${describe(error)}`)
    }
  }
  throw new Error(`下载失败（${failures.join('；')}）`)
}
