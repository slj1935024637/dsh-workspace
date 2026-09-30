/*
 * @Description: 右键菜单（远程文件树 / Git 改动列表共用）+ 文本复制 + 跨面板的远程文件剪贴板
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/ContextMenu.tsx
 *
 * 菜单用 position: fixed 摆在鼠标处，超出视口时向内收；点外面 / Esc / 滚动 / 窗口失焦即关闭。
 * （不在窗口缩放时关闭：无头截图会触发一次 resize，且缩放时菜单留在原处也无害。）
 * 不用宿主 Menu：它需要一个锚点元素，右键菜单的锚点是鼠标坐标。
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'

export type MenuItem = { id: string; label: string; danger?: boolean; disabled?: boolean; icon?: ReactNode } | { type: 'separator' }

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
  onSelect(id: string): void
}

/**
 * 右键菜单 hook：返回 [要渲染的菜单节点, 打开函数]。
 * 打开函数直接接在 onContextMenu 上：会阻止浏览器默认菜单。
 */
export function useContextMenu(): [ReactNode, (e: ReactMouseEvent, items: MenuItem[], onSelect: (id: string) => void) => void] {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const open = (e: ReactMouseEvent, items: MenuItem[], onSelect: (id: string) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    lastPoint = { x: e.clientX, y: e.clientY }
    setMenu({ x: e.clientX, y: e.clientY, items, onSelect })
  }
  const node = menu === null ? null : <ContextMenuView menu={menu} onClose={() => setMenu(null)} />
  return [node, open]
}

function ContextMenuView(props: { menu: OpenMenu; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: props.menu.x, top: props.menu.y })

  // 按实际尺寸收进视口（右边 / 下边放不下就往左 / 往上翻）。
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(props.menu.x, window.innerWidth - width - 4))
    const top = props.menu.y + height > window.innerHeight - 4 ? Math.max(4, props.menu.y - height) : props.menu.y
    setPos({ left, top })
  }, [props.menu])

  useEffect(() => {
    const close = props.onClose
    const onDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node) !== true) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [props.onClose])

  return (
    <div ref={ref} className="dshws-ctx" role="menu" style={{ left: pos.left, top: pos.top }} onContextMenu={(e) => e.preventDefault()}>
      {props.menu.items.map((item, i) =>
        'type' in item ? (
          <div key={`sep-${i}`} className="dshws-ctx-sep" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="dshws-ctx-item"
            data-danger={item.danger === true}
            disabled={item.disabled}
            onClick={() => {
              props.onClose()
              props.menu.onSelect(item.id)
            }}
          >
            <span className="dshws-ctx-ico">{item.icon ?? null}</span>
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}

/** 最近一次右键的位置：浮动提示出现在这里（用户视线所在处）。 */
let lastPoint: { x: number; y: number } | null = null

/**
 * 浮动提示（「已复制路径」等）：直接挂到 body 上的 fixed 小气泡，1.6 秒后淡出移除（错误 4 秒）。
 * 不走 React 状态、不占文档流 —— 原先插在列表顶部的提示条会把整个列表往下推，造成抖动。
 */
export function showFloat(text: string, tone: 'ok' | 'error' = 'ok'): void {
  const el = document.createElement('div')
  el.className = 'dshws-float'
  el.dataset.tone = tone
  el.setAttribute('role', 'status')
  el.textContent = text
  const p = lastPoint ?? { x: window.innerWidth / 2, y: window.innerHeight - 60 }
  el.style.left = `${Math.max(8, Math.min(p.x + 12, window.innerWidth - 300))}px`
  el.style.top = `${Math.max(8, Math.min(p.y + 12, window.innerHeight - 48))}px`
  document.body.appendChild(el)
  const hold = tone === 'error' ? 4000 : 1600
  setTimeout(() => el.setAttribute('data-leaving', 'true'), hold)
  setTimeout(() => el.remove(), hold + 250)
}

/**
 * 在最近一次右键的位置弹出一个小浮层（输入名称 / 确认删除）。
 * 侧栏里没有页面级的对话框服务，且桌面版（Electron）不支持 window.prompt，所以自己画一个：
 * 直接挂到 body，回车确定、Esc 或点外面取消。
 */
function popover(build: (box: HTMLDivElement, done: (ok: boolean) => void) => HTMLElement | null): Promise<boolean> {
  return new Promise((resolve) => {
    const box = document.createElement('div')
    box.className = 'dshws-ask'
    box.setAttribute('role', 'dialog')
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      document.removeEventListener('mousedown', onDown, true)
      box.remove()
      resolve(ok)
    }
    const onDown = (e: MouseEvent): void => {
      if (!box.contains(e.target as Node)) done(false)
    }
    const focus = build(box, done)
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        done(false)
      }
    })
    document.body.appendChild(box)
    const p = lastPoint ?? { x: window.innerWidth / 2 - 140, y: window.innerHeight / 3 }
    const { width, height } = box.getBoundingClientRect()
    box.style.left = `${Math.max(8, Math.min(p.x, window.innerWidth - width - 8))}px`
    box.style.top = `${Math.max(8, Math.min(p.y, window.innerHeight - height - 8))}px`
    document.addEventListener('mousedown', onDown, true)
    ;(focus ?? box).focus()
  })
}

function button(label: string, primary: boolean, danger: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dshws-ask-btn'
  b.dataset.primary = String(primary)
  b.dataset.danger = String(danger)
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

/** 输入一个名称；取消返回 null。validate 返回错误文案则不提交。 */
export async function askText(options: {
  title: string
  initial?: string
  okLabel: string
  cancelLabel: string
  validate?(value: string): string | undefined
}): Promise<string | null> {
  let value = ''
  const ok = await popover((box, done) => {
    const title = document.createElement('div')
    title.className = 'dshws-ask-title'
    title.textContent = options.title
    const input = document.createElement('input')
    input.className = 'dshws-input dshws-ask-input'
    input.spellcheck = false
    input.value = options.initial ?? ''
    const note = document.createElement('div')
    note.className = 'dshws-ask-note'
    const submit = (): void => {
      const problem = options.validate?.(input.value)
      if (problem !== undefined) {
        note.textContent = problem
        return
      }
      value = input.value
      done(true)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit()
    })
    const row = document.createElement('div')
    row.className = 'dshws-ask-row'
    row.append(button(options.cancelLabel, false, false, () => done(false)), button(options.okLabel, true, false, submit))
    box.append(title, input, note, row)
    return input
  })
  return ok ? value : null
}

/** 确认一次危险操作。 */
export function askConfirm(options: { message: string; okLabel: string; cancelLabel: string; danger?: boolean }): Promise<boolean> {
  return popover((box, done) => {
    const text = document.createElement('div')
    text.className = 'dshws-ask-message'
    text.textContent = options.message
    const ok = button(options.okLabel, true, options.danger === true, () => done(true))
    const row = document.createElement('div')
    row.className = 'dshws-ask-row'
    row.append(button(options.cancelLabel, false, false, () => done(false)), ok)
    box.append(text, row)
    return ok
  })
}

/** 复制文本到系统剪贴板；navigator.clipboard 不可用（非安全上下文）时退回 execCommand。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    /* 退回旧办法 */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    ta.remove()
  }
}

/** 远程文件剪贴板（「复制」后在任意远程文件树里「粘贴」）。只在同一台主机内粘贴。 */
export interface RemoteClip {
  hostId: string
  path: string
  isDir: boolean
}

let clip: RemoteClip | null = null
const clipListeners = new Set<() => void>()

export const remoteClipboard = {
  get: (): RemoteClip | null => clip,
  set(next: RemoteClip): void {
    clip = next
    for (const l of clipListeners) l()
  },
  subscribe(listener: () => void): () => void {
    clipListeners.add(listener)
    return () => {
      clipListeners.delete(listener)
    }
  }
}

/** 远程路径相对某根目录的相对路径；不在根下时原样返回绝对路径。 */
export function relativeTo(root: string, abs: string): string {
  const r = root.replace(/\/+$/, '')
  if (abs === r) return '.'
  return abs.startsWith(`${r}/`) ? abs.slice(r.length + 1) : abs
}
