/*
 * @Description: 让会话顶部标签（conversation.view）里的面板正好占满可视高度 —— 左右两列才能各自滚动
 * @Author: YangHeng
 * @Date: 2026-09-30 14:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/fit-height.ts
 *
 * 宿主的会话视图区（dsh-client-ui-conversation 的 viewArea）在会话进行中是 `flex: 1 0 auto; min-height: auto`：
 * 高度随内容增长，整块放在会话的滚动容器里。于是 height: 100% 不生效，文件树与右侧预览一起变长，
 * 滚动的是外层会话容器 —— 两列跟着一起滚。
 * 这里量出「外层滚动容器的可视高度 − 本面板之上的内容 − 本面板之下的内容（输入框等）」，把面板高度钉死，
 * 外层就不再需要滚动，滚动只发生在两列各自的列表 / 编辑器里。
 */
import { createElement, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'

/** 最近的纵向滚动祖先（overflow-y 为 auto / scroll）。 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p
  }
  return null
}

/** 纯函数：可用高度（便于单测）。 */
export function fitHeight(viewport: number, above: number, below: number, min = 240): number {
  return Math.max(min, Math.floor(viewport - above - below))
}

export function useFitHeight(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const scroller = scrollParent(el)
    // 没有滚动祖先：父级已给出确定高度，height: 100% 本身就能生效。
    if (scroller === null) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const sRect = scroller.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      // 在滚动内容坐标系里：面板顶部之上的内容高度、面板底部之下的内容高度（与面板自身高度无关）。
      const above = eRect.top - sRect.top + scroller.scrollTop
      const below = Math.max(0, scroller.scrollHeight - (above + eRect.height))
      const next = fitHeight(scroller.clientHeight, above, below)
      // 一挂载就钉住（即使此刻正好相等）：否则内容加载后会先撑高、下一帧才缩回，而且外层滚动条会闪。
      const px = `${next}px`
      if (el.style.height !== px) el.style.height = px
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    ro?.observe(scroller)
    // 输入框等兄弟内容变高 / 变矮也要重算：观察滚动容器的直接子元素。
    for (const child of Array.from(scroller.children)) ro?.observe(child)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      el.style.height = ''
    }
  }, [ref])
}

/** 会话顶部标签的外壳：.dshws-conv-view + 高度钉成可视高度。 */
export function FitView(props: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useFitHeight(ref)
  return createElement('div', { ref, className: 'dshws-conv-view' }, props.children)
}