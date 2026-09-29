/*
 * @Description: 浏览器端类型化远程调用 —— 描述符与宿主端同源生成
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/api.ts
 */
import { PACKAGE, SERVICE, buildDescriptors, makeCodec, type MethodName } from '../wire/contract.js'
import type { MethodIO } from '../wire/dto.js'
import type { ClientContext } from './context.js'

/**
 * 浏览器端 codec 直通即可：严格校验由宿主端 manifest 承担，
 * 浏览器 bundle 也因此不需要打进 zod。
 */
const CONTRIBUTION = {
  package: PACKAGE,
  descriptors: buildDescriptors((symbol) => makeCodec(symbol, (value) => value))
}

/** 远程调用失败。按 code 分支，不要解析 message。 */
export class RemoteCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message)
    this.name = 'RemoteCallError'
  }
}

interface RemoteResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

export interface WorkspaceApi {
  call<M extends MethodName>(method: M, payload: MethodIO[M][0]): Promise<MethodIO[M][1]>
}

/** 挂载远程贡献并返回类型化调用器。所有调用都等待挂载完成。 */
export function createApi(ctx: ClientContext): WorkspaceApi {
  const mounted = Promise.resolve(ctx.remote.$mount(CONTRIBUTION))

  return {
    async call(method, payload) {
      await mounted
      const remote = ctx.get(`remote.${SERVICE}`) as
        | Record<string, (payload: unknown) => Promise<RemoteResult>>
        | undefined
      const fn = remote?.[method]
      if (typeof fn !== 'function') {
        throw new RemoteCallError(
          'dsh-workspace/unavailable',
          '宿主服务尚未就绪，请稍后重试或刷新页面。',
          {}
        )
      }
      const result = await fn.call(remote, payload)
      if (!result.ok) {
        const error = result.error ?? { code: 'gateway/internal', message: '未知错误' }
        throw new RemoteCallError(error.code, error.message, error.details ?? {})
      }
      return result.value as never
    }
  }
}
