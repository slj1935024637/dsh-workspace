/*
 * @Description: 分组下拉选择 —— 树形缩进列表 + 筛选 / 输入新分组路径（替代原生 datalist）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/GroupSelect.tsx
 *
 * 弹层用 position: fixed 按触发器位置摆放：表单在弹窗里且可滚动（overflow），绝对定位会被裁掉。
 * 弹层打开时外层滚动直接收起、窗口缩放则重新定位，避免弹层与触发器错位。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Translate } from '../context.js'
import { IconChevronDown } from '../icons.js'
import { IconFolder, IconPlus } from '../sidebar/ui.js'

export interface GroupSelectProps {
  t: Translate
  value: string
  /** 可选分组路径（已排序）。 */
  paths: string[]
  onChange(path: string): void
  /** 允许输入不存在的路径（保存主机时自动建出该分组）。 */
  allowCreate?: boolean
  /** 不可选的路径（如编辑分组时的自身与后代）。 */
  disabled?: (path: string) => boolean
  /** 空值（根）的显示文字。 */
  rootLabel: string
}

const POP_MAX_HEIGHT = 300

/** 规整用户输入的分组路径：去掉首尾与重复斜杠、两端空白。 */
export function normalizePath(input: string): string {
  return input
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('/')
}

export function GroupSelect(props: GroupSelectProps) {
  const { t } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const place = (): void => {
    const el = triggerRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const style: CSSProperties = { position: 'fixed', left: r.left, width: Math.max(r.width, 240) }
    // 下方放不下就向上弹。
    if (below < POP_MAX_HEIGHT + 12 && r.top > below) style.bottom = window.innerHeight - r.top + 4
    else style.top = r.bottom + 4
    setPos(style)
  }

  useLayoutEffect(() => {
    if (!open) return
    place()
    // preventScroll：autoFocus 会让外层可滚动的表单滚一下，触发下面的「滚动即收起」。
    searchRef.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (popRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onScroll = (e: Event): void => {
      if (popRef.current?.contains(e.target as Node) === true) return
      setOpen(false)
    }
    // 窗口缩放时跟着重新定位（不收起）。
    const onResize = (): void => place()
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  // 补齐祖先路径（只有 a/b 没有 a 时也要显示 a），按路径排序即为树的先序。
  const allPaths = useMemo(() => {
    const set = new Set<string>()
    for (const p of props.paths) {
      const parts = p.split('/')
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [props.paths])
  const typed = normalizePath(query)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allPaths.filter((p) => q === '' || p.toLowerCase().includes(q))
  }, [allPaths, query])
  const canCreate = props.allowCreate === true && typed !== '' && !allPaths.includes(typed)

  const pick = (path: string): void => {
    props.onChange(path)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="dshws-gsel">
      <button
        ref={triggerRef}
        type="button"
        className="dshws-gsel-trigger"
        data-open={open}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={props.value !== '' ? props.value : props.rootLabel}
      >
        <IconFolder size={15} />
        <span className="dshws-gsel-value" data-empty={props.value === ''}>
          {props.value !== '' ? props.value.split('/').join(' / ') : props.rootLabel}
        </span>
        <IconChevronDown size={14} />
      </button>

      {open ? (
        <div
          ref={popRef}
          className="dshws-gsel-pop"
          style={pos}
          role="listbox"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // 只收起下拉，不关掉外层弹窗。
              e.stopPropagation()
              setOpen(false)
            }
          }}
        >
          <input
            ref={searchRef}
            className="dshws-input dshws-gsel-search"
            value={query}
            placeholder={props.allowCreate === true ? t('form.groupSearchOrNew') : t('form.groupSearch')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (canCreate) pick(typed)
                else if (shown.length === 1 && shown[0] !== undefined && props.disabled?.(shown[0]) !== true) pick(shown[0])
              }
            }}
          />
          <div className="dshws-gsel-list">
            {query.trim() === '' ? (
              <button type="button" className="dshws-gsel-opt" data-active={props.value === ''} onClick={() => pick('')}>
                <span className="dshws-gsel-root">{props.rootLabel}</span>
              </button>
            ) : null}
            {shown.map((p) => {
              const depth = p.split('/').length - 1
              const name = p.slice(p.lastIndexOf('/') + 1)
              const disabled = props.disabled?.(p) === true
              return (
                <button
                  key={p}
                  type="button"
                  className="dshws-gsel-opt"
                  data-active={props.value === p}
                  disabled={disabled}
                  title={p}
                  // 筛选时显示完整路径，不缩进；否则按层级缩进只显示末段。
                  style={query.trim() === '' ? { paddingLeft: 10 + depth * 16 } : undefined}
                  onClick={() => pick(p)}
                >
                  <IconFolder size={14} />
                  <span className="dshws-gsel-name">{query.trim() === '' ? name : p}</span>
                </button>
              )
            })}
            {canCreate ? (
              <button type="button" className="dshws-gsel-opt" data-create="true" onClick={() => pick(typed)}>
                <IconPlus size={14} />
                <span className="dshws-gsel-name">{t('form.groupCreate', { name: typed })}</span>
              </button>
            ) : null}
            {shown.length === 0 && !canCreate && query.trim() !== '' ? <div className="dshws-gsel-empty">{t('list.noMatch')}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
