/*
 * @Description: 「升级后待提示重启」标记 —— 安装会让宿主重载本插件的浏览器端代码，页面被带离，靠它回到全局配置并弹出重启提示
 * @Author: YangHeng
 * @Date: 2026-09-30 15:00:00
 * @FilePath: /dsh-workspace/src/client/page/update-flag.ts
 *
 * 现象：插件管理器装完新包、改写 profile 后，宿主会重新加载插件的浏览器端代码（主区插槽重建），
 * 「远程工作区」页面随之被关回会话，页面里的组件状态（包括「安装完成」弹窗）全部丢失。
 * 所以开始安装时把标记写进 localStorage（重载后仍在）；新代码启动时看到标记就回到全局配置页，
 * 更新卡片据此弹出「升级完成，是否重启」，弹过即清除。
 */

const KEY = 'dshws.update.awaitingRestart'
/** 标记有效期：超过就视为过期（例如安装中途关掉了 DSH），不再自动跳转。 */
const TTL_MS = 30 * 60_000

export interface AwaitingRestart {
  version: string
  at: number
}

export function markAwaiting(version: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version, at: Date.now() }))
  } catch {
    /* 存储不可用：退化为只在当前页面内提示 */
  }
}

export function readAwaiting(now = Date.now()): AwaitingRestart | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const v = JSON.parse(raw) as Partial<AwaitingRestart>
    if (typeof v.version !== 'string' || typeof v.at !== 'number' || now - v.at > TTL_MS) {
      localStorage.removeItem(KEY)
      return null
    }
    return { version: v.version, at: v.at }
  } catch {
    return null
  }
}

export function clearAwaiting(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

/** 页面初始打开哪个分区（插件代码重载后回到全局配置用）；取一次即清。 */
let requestedSection: string | null = null
export function requestSection(section: string): void {
  requestedSection = section
}
export function takeRequestedSection(): string | null {
  const s = requestedSection
  requestedSection = null
  return s
}
