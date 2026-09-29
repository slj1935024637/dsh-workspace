/*
 * @Description: 自适应左右分栏 —— 容器够宽时左列表右内容（列表宽度可拖动调整），窄时内容整页覆盖列表（保持原来的交互）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/Split.tsx
 *
 * 为什么量容器而不是量窗口：右侧栏可拖宽、还能再分栏，会话顶部标签又占满主区 ——
 * 同一个组件在不同位置宽度差别很大，只有 ResizeObserver 量自己的容器才准（DSH 也没有提供宽度接口）。
 *
 * 列表宽度：拖动中间的分隔条调整，按 storageKey 记在浏览器里（远程文件 / 远程 Git 各记各的）；
 * 双击分隔条恢复默认；分隔条获得焦点时可用 ← → 微调。
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

/** 左右分栏的最小容器宽度。 */
export const SPLIT_MIN_WIDTH = 700
/** 列表最小宽度。 */
export const LIST_MIN_WIDTH = 240
/** 右侧内容至少保留的宽度（列表最多拖到「容器宽 − 这个值」）。 */
export const DETAIL_MIN_WIDTH = 320
/** 键盘微调步长。 */
const KEY_STEP = 16

/** 纯函数：给定宽度是否分栏（便于单测）。 */
export function isWide(width: number, min = SPLIT_MIN_WIDTH): boolean {
  return width >= min
}

/** 默认列表宽度：容器的 40%，限制在 300–520px（与原来的 CSS clamp 一致）。 */
export function defaultListWidth(container: number): number {
  return Math.round(Math.min(520, Math.max(300, container * 0.4)))
}

/**
 * 把列表宽度收进允许范围：不小于 LIST_MIN_WIDTH，且给右侧留出 DETAIL_MIN_WIDTH。
 * 容器太窄、两者冲突时以列表最小宽度为准。
 */
export function clampListWidth(width: number, container: number): number {
  const max = Math.max(LIST_MIN_WIDTH, container - DETAIL_MIN_WIDTH)
  return Math.round(Math.min(max, Math.max(LIST_MIN_WIDTH, width)))
}

const STORAGE_PREFIX = 'dshws.split.'

function readStored(key: string | undefined): number | null {
  if (key === undefined) return null
  try {
    const v = Number(localStorage.getItem(STORAGE_PREFIX + key))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function writeStored(key: string | undefined, width: number | null): void {
  if (key === undefined) return
  try {
    if (width === null) localStorage.removeItem(STORAGE_PREFIX + key)
    else localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(width)))
  } catch {
    /* 存储不可用时只是不记住 */
  }
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
  /** 记住列表宽度用的键；缺省不记住。 */
  storageKey?: string
  /** 分隔条的提示文字。 */
  resizeLabel?: string
}

export function Split(props: SplitProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)
  /** 用户调整过的宽度（未调整为 null → 按容器算默认值）。 */
  const [preferred, setPreferred] = useState<number | null>(() => readStored(props.storageKey))
  const [dragging, setDragging] = useState(false)
  const notify = useRef(props.onWideChange)
  notify.current = props.onWideChange

  useEffect(() => {
    const el = hostRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const update = (width: number): void => {
      setContainerWidth(width)
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

  // 存的是用户想要的宽度；实际宽度每次按当前容器收进范围（容器变窄时不改写存储，变宽后能恢复）。
  const listWidth = clampListWidth(preferred ?? defaultListWidth(containerWidth), containerWidth)

  const commit = (width: number | null): void => {
    setPreferred(width)
    writeStored(props.storageKey, width)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const startX = e.clientX
    const startWidth = listWidth
    const container = containerWidth
    let latest = startWidth
    // 捕获指针：鼠标拖出分隔条（甚至移到右侧 iframe 上）也继续收到移动事件。
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效（极少见）：退化为只在分隔条上跟随 */
    }
    setDragging(true)
    const onMove = (ev: PointerEvent): void => {
      latest = clampListWidth(startWidth + ev.clientX - startX, container)
      setPreferred(latest)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setDragging(false)
      // 拖动中只更新状态，松手才写存储。
      commit(latest)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    commit(clampListWidth(listWidth + (e.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP), containerWidth))
  }

  return (
    <div ref={hostRef} className="dshws-split" data-wide={wide} data-dragging={dragging}>
      {wide ? (
        <>
          <div className="dshws-split-list" style={{ flexBasis: listWidth }}>
            {props.list}
          </div>
          <div
            className="dshws-split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={listWidth}
            aria-valuemin={LIST_MIN_WIDTH}
            aria-valuemax={clampListWidth(Number.MAX_SAFE_INTEGER, containerWidth)}
            aria-label={props.resizeLabel}
            title={props.resizeLabel}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onDoubleClick={() => commit(null)}
            onKeyDown={onKeyDown}
          />
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
