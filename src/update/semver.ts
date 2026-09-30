/*
 * @Description: 语义化版本比较（含预发布段），供「检查更新」判断新旧
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/update/semver.ts
 *
 * 只实现本插件需要的子集：MAJOR.MINOR.PATCH[-pre][+build]，比较规则同 semver 2.0：
 * 0.10.2-dev.20260930 < 0.10.2（开发包会被提示升级到正式版），但 > 0.10.1（不会提示降级）。
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: Array<string | number>
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本号；不是合法 semver（如未打包时的 'dev'）返回 undefined。 */
export function parseVersion(raw: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(raw.trim())
  if (m === null) return undefined
  const pre = m[4] === undefined ? [] : m[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
}

/** a < b 返回负数，相等 0，a > b 正数。任一无法解析时抛错（调用方应先 parseVersion 判断）。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === undefined || pb === undefined) throw new Error(`无法比较的版本号：${a} / ${b}`)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  // 有预发布段的版本低于同号正式版。
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    // 数字段低于字母段；同类按数值 / 字典序。
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** latest 是否比 current 新。current 不是合法版本（开发环境 'dev'）时返回 false。 */
export function isNewer(latest: string, current: string): boolean {
  if (parseVersion(latest) === undefined || parseVersion(current) === undefined) return false
  return compareVersions(latest, current) > 0
}
