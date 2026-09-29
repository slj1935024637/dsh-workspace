/*
 * @Description: 远程 Git 面板「本会话默认查看的分支」—— 按会话保存在浏览器本地
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/git-default.ts
 *
 * 为什么按会话、存在浏览器：这是界面偏好（进入面板时先看哪个分支），不影响远程仓库；
 * 侧栏与会话顶部的「远程 Git」拿到的是同一个 sessionId，自然共用同一份设置。
 */

const PREFIX = 'dshws.git.defaultRef.'

interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(): KV | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** 本会话默认查看的分支（完整引用名，如 refs/heads/feature/x）；未设置为 null。 */
export function getDefaultRef(sessionId: string, kv: KV | undefined = storage()): string | null {
  const v = kv?.getItem(PREFIX + sessionId) ?? null
  return v !== null && /^refs\/(heads|remotes|tags)\/.+/.test(v) ? v : null
}

/** 设置 / 清除（ref 为 null）。 */
export function setDefaultRef(sessionId: string, ref: string | null, kv: KV | undefined = storage()): void {
  if (kv === undefined) return
  if (ref === null) kv.removeItem(PREFIX + sessionId)
  else kv.setItem(PREFIX + sessionId, ref)
}
