/*
 * @Description: ssh2 延迟加载 —— 原生模块绝不能在模块顶层 import
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/ssh/lazy.ts
 */
import { createRequire } from 'node:module'

/**
 * 为什么必须 lazy：ssh2 依赖原生模块（cpu-features / 可选的 sshcrypto 绑定）。
 * DSH 的插件加载器里，任何一行 loader entry 的 apply 失败都会中止整个启动流程，
 * 所以顶层 `import ssh2` 一旦因为 pnpm 未构建原生依赖而抛错，
 * 倒下的不是本插件而是整个 `dsh web` 服务。
 *
 * better-sidebar 的 pty-deps.ts 因为同样的原因踩过坑（其 issue #140），
 * 这里沿用同一套「首次调用时 require + 缓存结果 + 失败降级」的模式。
 */

/** ssh2 模块的最小结构约束，避免把整个 @types/ssh2 拖进运行时契约。 */
export interface Ssh2Module {
  Client: new () => unknown
  utils?: unknown
}

type LoadResult =
  | { ok: true; module: Ssh2Module }
  | { ok: false; cause: unknown }

const localRequire = createRequire(import.meta.url)

let cached: LoadResult | undefined

/**
 * 加载 ssh2，失败返回 null（不抛错）。
 * 结果会被缓存：一次失败之后不再反复尝试，避免每次连接都吃一遍解析开销。
 */
export function loadSsh2(requireImpl: NodeRequire = localRequire): Ssh2Module | null {
  if (cached === undefined) {
    try {
      cached = { ok: true, module: requireImpl('ssh2') as Ssh2Module }
    } catch (cause) {
      cached = { ok: false, cause }
    }
  }
  return cached.ok ? cached.module : null
}

/**
 * 加载 ssh2，失败时抛出一个带可操作修复指引的错误。
 * 供「用户主动发起连接」这类需要明确反馈的路径使用。
 */
export function requireSsh2(requireImpl: NodeRequire = localRequire): Ssh2Module {
  const module = loadSsh2(requireImpl)
  if (module !== null) return module
  const cause = cached !== undefined && !cached.ok ? cached.cause : undefined
  throw new Error(ssh2FailureMessage(cause), cause === undefined ? undefined : { cause })
}

/** 当前 ssh2 是否可用（用于 UI 上提前给出提示，而不是等用户点了连接才报错）。 */
export function isSsh2Available(): boolean {
  return loadSsh2() !== null
}

/** 上一次加载失败的原因；从未失败则返回 undefined。 */
export function ssh2LoadFailure(): unknown {
  return cached !== undefined && !cached.ok ? cached.cause : undefined
}

/** 仅供测试：清空缓存，让下一次调用重新尝试加载。 */
export function resetSsh2Cache(): void {
  cached = undefined
}

/**
 * 构造修复指引。pnpm 11 的 strict-dep-builds 会拦截原生依赖的构建脚本，
 * 这是本插件在新机器上最常见的失败原因，所以指引要直接给出要改的文件和字段。
 */
function ssh2FailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause ?? 'unknown error')
  return [
    `dsh-workspace: 无法加载 ssh2（${detail}）。`,
    '',
    'ssh2 及其可选加速依赖 cpu-features 含原生构建步骤，pnpm 11 默认会拦截构建脚本。',
    '请在 profile 的 pnpm-workspace.yaml 中确认存在：',
    '',
    '  allowBuilds:',
    '    ssh2: true',
    '    cpu-features: true',
    '',
    '修改后重新安装该 profile 的依赖，再重启 DSH。'
  ].join('\n')
}
