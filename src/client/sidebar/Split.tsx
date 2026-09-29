/*
 * @Description: 自适应左右分栏 —— 容器够宽时左列表右内容，窄时内容整页覆盖列表（保持原来的交互）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/Split.tsx
 *
 * 为什么量容器而不是量窗口：右侧栏可拖宽、还能再分栏，会话顶部标签又占满主区 ——
 * 同一个组件在不同位置宽度差别很大，只有 ResizeObserver 量自己的容器才准（DSH 也没有提供宽度接口）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 左右分栏的最小容器宽度。 */
export const SPLIT_MIN_WIDTH = 700

/** 纯函数：给定宽度是否分栏（便于单测）。 */
export function isWide(width: number, min = SPLIT_MIN_WIDTH): boolean {
  return width >= min
}

export interface SplitProps {
  /** 列表（左侧 / 窄时的主页面）。 */
  list: ReactNode
  /** 内容（右侧 / 窄时覆盖列表）；null 表示没打开任何内容。 */
  detail: ReactNode | null
  /** 宽时右侧空白处的提示。 */
  placeholder?: ReactNode
  /** 宽窄变化时通知（例如远程文件树据此决定是在右侧打开还是新开标签）。 */
  onWideChange?(wide: boolean): void
}

export function Split(props: SplitProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const notify = useRef(props.onWideChange)
  notify.current = props.onWideChange

  useEffect(() => {
    const el = hostRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const update = (width: number): void => {
      const next = isWide(width)
      setWide((cur) => {
        if (cur !== next) notify.current?.(next)
        return next
      })
    }
    update(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) update(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={hostRef} className="dshws-split" data-wide={wide}>
      {wide ? (
        <>
          <div className="dshws-split-list">{props.list}</div>
          <div className="dshws-split-detail">
            {props.detail ?? <div className="dshws-split-empty">{props.placeholder}</div>}
          </div>
        </>
      ) : props.detail !== null ? (
        <div className="dshws-split-detail">{props.detail}</div>
      ) : (
        <div className="dshws-split-list">{props.list}</div>
      )}
    </div>
  )
}
