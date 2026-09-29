/*
 * @Description: Typert 远程服务的最小运行时 —— 不依赖 @deepseek-ai/dsh-typert-protocol
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/wire/remote.ts
 *
 * 为什么自己实现，而不是 import typert-protocol：
 *
 * DSH 解析插件依赖时「profile 优先，安装层兜底」。用户 profile 里其他插件
 * （dsh-skill-mcp-panel）带进来了 typert-protocol@0.1.0-rc.6，本插件会解析到这个旧版，
 * 而不是宿主自带的 0.1.7。旧版没有导出 RemoteError / remoteErrorOf ——
 * ESM 具名导入缺失在链接期就失败，插件整个加载不了，并且会中止 DSH 启动。
 * 版本号由别的插件决定、随时会变，本插件无法控制，所以干脆不依赖它。
 *
 * 宿主网关对服务与错误的要求都是结构性的（已核对 0.1.5 / 0.1.7 两版源码）：
 *   - 服务：带 `typertRemote = { service: 自身, serviceKey, namespace }` 冻结对象
 *     （dsh-api-gateway validateBinding / readBinding，不做 instanceof）
 *   - 错误：带 `isDSHRemoteError === true` 与字符串 `code`（remoteErrorOf 结构判定）
 * 这里按同样的结构实现，新旧宿主都认。
 */
import { Service, type Context } from '@deepseek-ai/cordis'

/** 本插件的错误码与各自的 details 形状。 */
export interface RemoteErrorDetailsMap {
  /** 保险箱已锁定：浏览器应弹出解锁框。 */
  'dsh-workspace/vault-locked': {}
  /** 尚未设置主密码：浏览器应引导去设置。 */
  'dsh-workspace/vault-uninitialized': {}
  /** 主机配置不完整或有结构错误（缺用户名、跳板成环等）。 */
  'dsh-workspace/invalid-config': {}
  /** 主机指纹变更：安全事件，携带新旧指纹供人工核对。 */
  'dsh-workspace/host-key-changed': {
    readonly endpoint: string
    readonly expected: string
    readonly actual: string
  }
  /** ssh2 原生模块不可用。 */
  'dsh-workspace/ssh2-unavailable': {}
  /** 目标已存在（重命名 / 新建 / 上传不覆盖时）。 */
  'dsh-workspace/exists': { readonly path: string }
  /** 远端路径不存在。 */
  'dsh-workspace/not-found': {}
  /** 保存时发现远端文件在打开之后被改过（mtime / size 为远端当前值）。 */
  'dsh-workspace/conflict': { readonly mtime: number; readonly size: number }
  /** 其余业务失败，message 即原因。 */
  'dsh-workspace/failed': {}
}

export type RemoteErrorCode = keyof RemoteErrorDetailsMap

/**
 * 远程调用失败。网关把它原样编码为 `{ code, message, details }` 发给浏览器；
 * 普通 Error 则会被统一包成 `gateway/internal`，丢失 code。
 */
export class RemoteError<C extends RemoteErrorCode = RemoteErrorCode> extends Error {
  readonly code: C
  readonly details: RemoteErrorDetailsMap[C]
  /** 结构标记：宿主网关靠它识别（跨模块副本时不能用 instanceof）。 */
  readonly isDSHRemoteError = true

  constructor(code: C, message: string, details: RemoteErrorDetailsMap[C], options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.details = details
    this.name = 'RemoteError'
  }
}

/** 结构判定：任何副本（含宿主或其他插件抛出的）RemoteError 都能识别。 */
export function remoteErrorOf(value: unknown): { code: string; message: string; details: unknown } | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { isDSHRemoteError?: unknown }).isDSHRemoteError === true &&
    typeof (value as { code?: unknown }).code === 'string'
  ) {
    return value as { code: string; message: string; details: unknown }
  }
  return undefined
}

/** 网关读取的绑定形状。 */
export interface RemoteBinding {
  readonly service: object
  readonly serviceKey: string
  readonly namespace: string
}

/**
 * 以 cordis Service 注册、并向网关暴露远程绑定的服务基类。
 *
 * `@deepseek-ai/cordis` 仍需运行时导入（Service 基类必须与宿主同一个）：
 * profile 里没有 cordis 时回落到安装层的宿主副本，与其他插件一致。
 * `scripts/check-host-resolution.mjs` 会在构建时核对这一点。
 */
export class RemoteService extends Service {
  readonly typertRemote: RemoteBinding

  constructor(ctx: Context, serviceKey: string) {
    super(ctx, serviceKey)
    this.typertRemote = Object.freeze({ service: this, serviceKey: this.name, namespace: this.name })
  }
}
