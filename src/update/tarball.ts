/*
 * @Description: 安装包（npm tgz）检查 —— 解压读出 package/package.json 并校验是本插件
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/update/tarball.ts
 *
 * 不引入 tar 依赖：npm pack 产物是标准 ustar，只需顺序扫描 512 字节头找到 package/package.json。
 * 在交给宿主安装之前先检查，错包（别的插件、损坏文件、改名的 zip）在这里就被挡下，不会去动 profile。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

/** 插件包名（与 package.json 的 name 一致）。 */
export const PLUGIN_PACKAGE = '@yh4922/dsh-workspace'

export interface TarballInfo {
  name: string
  version: string
  /** 文件的 sha256（十六进制），供界面展示与人工核对。 */
  sha256: string
  size: number
  /** 包声明的 @deepseek-ai/dsh* peer 范围（宿主安装时会再做兼容检查）。 */
  peers: Record<string, string>
}

export class TarballError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarballError'
  }
}

/** 解析 tar 头里的八进制数字字段（以 NUL / 空格结尾）。 */
function octal(buf: Buffer, start: number, length: number): number {
  const text = buf.subarray(start, start + length).toString('ascii').replace(/[\0 ]+$/g, '').trim()
  return text === '' ? 0 : parseInt(text, 8)
}

function cstr(buf: Buffer, start: number, length: number): string {
  const raw = buf.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

/** 从 pax 扩展头里取 path（长文件名时 npm 会写 pax 头）。 */
function paxPath(body: Buffer): string | undefined {
  const text = body.toString('utf8')
  const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
  return m?.[1]
}

/** 在 tar 数据里找指定文件，返回其内容；找不到返回 undefined。 */
export function findTarEntry(tar: Buffer, wanted: (name: string) => boolean): Buffer | undefined {
  let offset = 0
  let pendingName: string | undefined
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // 连续两个全零块 = 归档结束。
    if (header.every((b) => b === 0)) return undefined
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const bodyStart = offset + 512
    const body = tar.subarray(bodyStart, bodyStart + size)
    offset = bodyStart + Math.ceil(size / 512) * 512
    if (type === 'x') {
      pendingName = paxPath(body)
      continue
    }
    if (type === 'g') continue
    const prefix = cstr(header, 345, 155)
    const base = cstr(header, 0, 100)
    const name = pendingName ?? (prefix !== '' ? `${prefix}/${base}` : base)
    pendingName = undefined
    if ((type === '0' || type === '\0') && wanted(name)) return Buffer.from(body)
  }
  return undefined
}

/**
 * 检查安装包：必须是 gzip 的 npm 包，包名是本插件，带插件声明（dsh.bundle）。
 * @param expectedVersion 给了就要求版本号一致（在线更新时防止下到别的版本）
 */
export async function inspectTarball(file: string, expectedVersion?: string): Promise<TarballInfo> {
  const data = await readFile(file)
  let tar: Buffer
  try {
    tar = gunzipSync(data)
  } catch {
    throw new TarballError('不是有效的 .tgz 安装包（解压失败）。')
  }
  // npm pack 的根目录固定为 package/；个别工具打出的包根目录名不同，这里只认第一层下的 package.json。
  const entry = findTarEntry(tar, (name) => /^[^/]+\/package\.json$/.test(name))
  if (entry === undefined) throw new TarballError('安装包里没有 package.json。')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(entry.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new TarballError('安装包里的 package.json 无法解析。')
  }
  const name = typeof manifest.name === 'string' ? manifest.name : ''
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (name !== PLUGIN_PACKAGE) throw new TarballError(`不是本插件的安装包（包名：${name || '未知'}，应为 ${PLUGIN_PACKAGE}）。`)
  if (version === '') throw new TarballError('安装包缺少版本号。')
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new TarballError(`安装包版本不符：期望 ${expectedVersion}，实际 ${version}。`)
  }
  const dsh = manifest.dsh as { bundle?: unknown } | undefined
  if (dsh?.bundle === undefined) throw new TarballError('安装包缺少插件声明（dsh.bundle），不能安装。')
  const peers: Record<string, string> = {}
  const declared = manifest.peerDependencies
  if (declared !== null && typeof declared === 'object') {
    for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
      if (key.startsWith('@deepseek-ai/dsh') && typeof value === 'string') peers[key] = value
    }
  }
  return { name, version, sha256: createHash('sha256').update(data).digest('hex'), size: data.length, peers }
}
