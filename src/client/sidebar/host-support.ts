/*
 * @Description: 宿主端是否已是支持本地工作区的新版本 —— 升级后只刷新了页面、没重启 DSH 时给出明确提示
 * @Author: YangHeng
 * @Date: 2026-09-30 14:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/host-support.ts
 *
 * 浏览器端代码在刷新页面后就是新版，但插件宿主端（Node 进程里已加载的代码）要重启 DSH 才换。
 * 新前端把本地会话当成 local:<会话 id> 发给旧宿主端，旧宿主端会报「主机不存在：local:…」，用户看不懂。
 * 这里用「宿主端有没有 updateStatus 方法（与本地工作区同一版本加入）」判断，旧版就直接提示重启。
 */
import { useEffect, useState } from 'react'
import type { WorkspaceApi } from '../api.js'

let probe: Promise<boolean> | undefined

/** 宿主端是否支持本地工作区。只缓存「支持」：失败可能是宿主暂时未就绪，下次再探。 */
export function hostSupportsLocal(api: WorkspaceApi): Promise<boolean> {
  if (probe !== undefined) return probe
  const attempt = api.call('updateStatus', {}).then(
    () => true,
    () => {
      probe = undefined
      return false
    }
  )
  probe = attempt
  return attempt
}

/** 旧宿主端对本地会话的典型报错。 */
export function isOutdatedHostError(message: string): boolean {
  return /主机不存在：local:|host .*local:/i.test(message)
}

/** 本地工作区面板用：'checking' | 'ok' | 'outdated'；远程工作区直接 'ok'。 */
export function useLocalSupport(api: WorkspaceApi, local: boolean): 'checking' | 'ok' | 'outdated' {
  const [state, setState] = useState<'checking' | 'ok' | 'outdated'>(local ? 'checking' : 'ok')
  useEffect(() => {
    if (!local) {
      setState('ok')
      return
    }
    let alive = true
    void hostSupportsLocal(api).then((ok) => alive && setState(ok ? 'ok' : 'outdated'))
    return () => {
      alive = false
    }
  }, [api, local])
  return state
}
