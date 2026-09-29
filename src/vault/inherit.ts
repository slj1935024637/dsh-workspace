/*
 * @Description: 分组默认值继承 + 跳板链展开，产出连接池消费的 ResolvedTarget
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/vault/inherit.ts
 */
import type { GroupRecord, HostAuth, HostRecord, ResolvedTarget } from '../types.js'

/**
 * 按分组路径自顶向下收集默认值。
 *
 * 为什么要继承：几十台机器共用同一台堡垒机时，堡垒机地址变更
 * 应该只改一处，而不是翻遍所有主机记录。
 */
export function collectDefaults(groupPath: string, groups: GroupRecord[]): GroupRecord['defaults'] {
  if (groupPath === '') return {}
  const byPath = new Map(groups.map((g) => [g.path, g]))
  const segments = groupPath.split('/')
  let merged: GroupRecord['defaults'] = {}
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    const group = byPath.get(prefix)
    if (group !== undefined) merged = { ...merged, ...group.defaults }
  }
  return merged
}

/** 解析时可能出现的结构性错误（循环跳板、引用缺失）。 */
export class ResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResolveError'
  }
}

/**
 * 把一条主机记录解析成可直接连接的目标：套用分组继承、展开跳板链。
 *
 * @param hostId 目标主机 id
 * @param hosts 含凭据的主机全集（调用方负责已解锁）
 * @param groups 分组全集
 * @param seen 内部递归用，检测跳板环
 */
export function resolveTarget(
  hostId: string,
  hosts: Map<string, HostRecord>,
  groups: GroupRecord[],
  seen: string[] = []
): ResolvedTarget {
  if (seen.includes(hostId)) {
    throw new ResolveError(`跳板链存在循环引用：${[...seen, hostId].join(' → ')}`)
  }
  const host = hosts.get(hostId)
  if (host === undefined) throw new ResolveError(`主机不存在或已被删除：${hostId}`)

  const defaults = collectDefaults(host.groupPath, groups)

  const username = host.username ?? defaults.username
  if (username === undefined || username === '') {
    throw new ResolveError(`主机「${host.label}」未配置用户名，且所属分组也没有默认值。`)
  }

  const auth = host.auth ?? defaults.auth
  if (auth === undefined) {
    throw new ResolveError(`主机「${host.label}」未配置认证方式，且所属分组也没有默认值。`)
  }

  const jumpIds = host.jumpHostIds.length > 0 ? host.jumpHostIds : (defaults.jumpHostIds ?? [])
  const jumpChain = jumpIds.map((id) => resolveTarget(id, hosts, groups, [...seen, hostId]))

  const proxy = host.proxy ?? defaults.proxy
  const startupCommand = host.startupCommand ?? defaults.startupCommand
  const environmentVariables = mergeEnv(defaults.environmentVariables, host.environmentVariables)

  return {
    hostId: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port !== 0 ? host.port : (defaults.port ?? 22),
    username,
    auth: normalizeAuth(auth),
    ...(proxy !== undefined ? { proxy } : {}),
    jumpChain,
    ...(startupCommand !== undefined ? { startupCommand } : {}),
    ...(environmentVariables !== undefined ? { environmentVariables } : {})
  }
}

/** 环境变量按「分组在下、主机在上」合并，主机同名键覆盖分组。 */
function mergeEnv(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (base === undefined && override === undefined) return undefined
  return { ...(base ?? {}), ...(override ?? {}) }
}

/** 去掉空字符串形式的占位凭据（stripSecrets 会把密码抹成空串）。 */
function normalizeAuth(auth: HostAuth): HostAuth {
  if (auth.kind === 'password' && auth.password === '') {
    throw new ResolveError('密码为空：保险箱可能处于锁定状态，或该主机未设置密码。')
  }
  if (auth.kind === 'keyContent' && auth.keyContent === '') {
    throw new ResolveError('私钥内容为空：保险箱可能处于锁定状态。')
  }
  return auth
}
