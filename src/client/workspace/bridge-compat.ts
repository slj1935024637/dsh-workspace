/*
 * @Description: 与 dsh-bridge（@wenbin_wb/dsh-bridge，远程/手机访问插件）的共存处理 —— 接管「添加工作区」与移动端抽屉
 * @Author: YangHeng
 * @Date: 2026-09-30 10:00:00
 * @FilePath: /dsh-workspace/src/client/workspace/bridge-compat.ts
 *
 * 公网 / 局域网访问时，dsh-bridge 用两条独立的路径抢「添加工作区」：
 *   1. directoryFlow 插槽：它以 priority -10 注册。而本插件是动态包，宿主运行器（dsh-cordis-client-runner
 *      的 guardedSlots）会把我们传入的 priority 覆盖成页内递减计数（-1、-2…），-1000 根本不生效，
 *      计数没走到 -10 以下时就一直输给它。→ holdSlotHead：不是 head 就撤下重注册，拿到更小的号为止。
 *   2. document 捕获阶段的 click 监听：按按钮文字（aria-label / innerText 含「添加工作区」等）匹配，
 *      命中就 stopImmediatePropagation 并弹它自己的 DOM 弹窗，宿主的按钮回调根本不执行，插槽赢了也没用。
 *      → shieldAddWorkspaceClicks：在更早的 window 捕获阶段，把按钮 aria-label 临时换成中性值，
 *      让它的匹配落空，事件照常走到宿主，宿主再打开插槽里的（我们的）弹窗；事件派发完立即还原。
 * 另外它的移动端抽屉是 body.dsh-drawer-open 这个类控制的容器，宿主 toggleSidebar 不会同步它。
 */

/** dsh-bridge 移动端抽屉的开合类（它自己的容器样式都挂在这上面）。 */
export const BRIDGE_DRAWER_CLASS = 'dsh-drawer-open'

/** 收起 dsh-bridge 的移动端抽屉容器；没装它时是空操作。 */
export function closeBridgeDrawer(): void {
  if (typeof document === 'undefined') return
  document.body?.classList.remove(BRIDGE_DRAWER_CLASS)
}

interface SlotEntryLike {
  component?: unknown
  options?: { priority?: number }
}

/** 宿主 slots 的只读接口（跨内核版本可能不存在，一律可选调用）。 */
export interface SlotsPeek {
  entries?(key: string): ReadonlyArray<SlotEntryLike>
  entriesOfSlot?(key: string): ReadonlyArray<SlotEntryLike>
  subscribe?(key: string, fn: () => void): () => void
}

/** 单个插槽最多重注册的次数：dsh-bridge 是 -10，正常几次到十几次就够；上限只防意外死循环。 */
const MAX_BUMPS = 256

/**
 * 占住 single 插槽的 head（真正渲染的那条）。
 * 不是 head 就「撤下 → 重注册」换一个更小的 priority；之后订阅插槽变化，别人后来压过我们时再抢回。
 * 重注册拿不到更小的号（静态加载时 priority 就是我们传的定值）就停下，避免空转。
 * @param slots 宿主 slots（只用 entries / entriesOfSlot / subscribe）
 * @param slot 插槽名
 * @param register 注册一次并返回撤销函数
 * @param component 我们注册的组件（按组件身份识别自己的条目）
 * @param warn 抢不到时的告警
 */
export function holdSlotHead(slots: SlotsPeek, slot: string, register: () => () => void, component: unknown, warn: (message: string) => void): () => void {
  let dispose = register()
  let disposed = false
  let bumps = 0
  let warned = false

  const head = (): SlotEntryLike | undefined => slots.entriesOfSlot?.(slot)[0]
  const own = (): number | undefined => slots.entries?.(slot).find((e) => e.component === component)?.options?.priority

  let running = false
  const ensure = (): void => {
    // 自己的撤下 / 重注册也会触发订阅，重入时直接跳过。
    if (disposed || running || typeof slots.entriesOfSlot !== 'function') return
    running = true
    try {
      settle()
    } finally {
      running = false
    }
  }
  const settle = (): void => {
    while (bumps < MAX_BUMPS) {
      const h = head()
      if (h === undefined || h.component === component) return
      const before = own()
      dispose()
      dispose = register()
      bumps++
      const after = own()
      // 号没变小：说明 priority 是定值（未经运行器改写），再重注册也没用。
      if (before !== undefined && after !== undefined && after >= before) break
    }
    const h = head()
    if (!warned && h !== undefined && h.component !== component) {
      warned = true
      warn(`接管「添加工作区」被其他插件压过（${slot}，head priority=${String(h.options?.priority ?? 0)}）`)
    }
  }

  ensure()
  const off = slots.subscribe?.(slot, ensure)
  return () => {
    disposed = true
    off?.()
    dispose()
  }
}

/** 与 dsh-bridge 的判定保持一致：它会拦截的按钮，我们才去「中和」。 */
export function isAddWorkspaceButton(btn: Element): boolean {
  const label = (btn.getAttribute('aria-label') || (btn as HTMLElement).innerText || btn.getAttribute('title') || '').trim()
  return (
    label === '新建工作区' ||
    label === 'Add Workspace' ||
    label === 'Open Folder' ||
    label.includes('添加工作区') ||
    label.includes('打开工作区') ||
    label.includes('打开文件夹') ||
    btn.matches('button[aria-label*="工作区"][aria-label*="添加"], button[aria-label*="工作区"][aria-label*="打开"]')
  )
}

/** 临时替换用的 aria-label：不含「添加 / 打开 / 工作区 / 文件夹」，dsh-bridge 的任何一条规则都不会命中。 */
const NEUTRAL_LABEL = 'dshws-add-workspace'

/**
 * 在 window 捕获阶段（早于 dsh-bridge 挂在 document 上的捕获监听）中和它对「添加工作区」按钮的拦截。
 * 只改 aria-label 一个事件派发周期，宿主按钮自己的点击回调照常执行、照常打开 directoryFlow 插槽。
 * @returns 撤销函数
 */
export function shieldAddWorkspaceClicks(): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const btn = target.closest('button, [role="button"], a')
    if (btn === null || btn.closest('#dsh-remote-workspace-modal') !== null || !isAddWorkspaceButton(btn)) return
    const had = btn.hasAttribute('aria-label')
    const previous = btn.getAttribute('aria-label')
    btn.setAttribute('aria-label', NEUTRAL_LABEL)
    // 同步派发结束后再还原（宿主 React 回调在派发过程中同步执行，不受影响）。
    setTimeout(() => {
      if (btn.getAttribute('aria-label') !== NEUTRAL_LABEL) return
      if (had && previous !== null) btn.setAttribute('aria-label', previous)
      else btn.removeAttribute('aria-label')
    }, 0)
  }
  window.addEventListener('click', onClick, true)
  return () => window.removeEventListener('click', onClick, true)
}
