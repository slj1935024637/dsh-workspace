/*
 * @Description: 「接管添加工作区」开关的页内通知 —— 管理页切换后，入口处即时注册 / 撤下插槽，不用刷新
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/workspace/takeover.ts
 *
 * 管理页与插件入口在同一个浏览器 bundle 里，用模块级订阅即可；偏好本身仍由宿主持久化。
 */
type Listener = (enabled: boolean) => void

const listeners = new Set<Listener>()

/** 订阅开关变化；返回取消订阅函数。 */
export function onTakeoverChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 管理页写入偏好成功后调用。 */
export function emitTakeoverChange(enabled: boolean): void {
  for (const listener of listeners) listener(enabled)
}
