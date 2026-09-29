/*
 * @Description: 远程文件树的右键菜单逻辑（远程文件 / 远程 Git 的「文件」页共用）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/file-menu.tsx
 *
 * 菜单项：重命名 / 复制 / 粘贴 / 复制相对路径 / 复制绝对路径。
 * - 粘贴目标：右键目录 = 该目录；右键文件 = 它所在目录；右键空白处 = 树的根目录
 * - 剪贴板跨面板共享，但只能粘贴到同一台主机
 * - editable=false（查看未检出的分支）时只保留「复制相对路径」：分支里的文件不在磁盘上
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { WorkspaceApi } from '../api.js'
import type { Translate } from '../context.js'
import { copyText, relativeTo, remoteClipboard, showFloat, useContextMenu, type MenuItem } from './ContextMenu.js'

export interface FileMenuOptions {
  t: Translate
  api: WorkspaceApi
  hostId: string
  /** 树根的远程绝对路径（相对路径以它为基准）。 */
  root: string
  /** false：只读树（只提供复制相对路径）。 */
  editable: boolean
  /** 某目录内容变了，需要重载（远程绝对路径）。 */
  reloadDir(dir: string): void
  /** 某条目被改名（打开着的文件据此更新路径）。 */
  onRenamed?(from: string, to: string): void
  /** 粘贴出了新条目（目录据此展开）。 */
  onPasted?(dir: string, created: string): void
}

export interface FileMenu {
  node: ReactNode
  /** 在条目上右键。path 为远程绝对路径。 */
  openFor(e: ReactMouseEvent, path: string, isDir: boolean): void
  /** 在树的空白处右键（只有粘贴 / 复制根路径）。 */
  openForRoot(e: ReactMouseEvent): void
  /** 正在重命名的条目（远程绝对路径）。 */
  renaming: string | null
  submitRename(path: string, name: string): Promise<void>
  cancelRename(): void
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function useRemoteFileMenu(opts: FileMenuOptions): FileMenu {
  const { t } = opts
  const [node, open] = useContextMenu()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [, setClipVersion] = useState(0)
  useEffect(() => remoteClipboard.subscribe(() => setClipVersion((v) => v + 1)), [])

  // 提示一律用浮动气泡（showFloat），不插进列表 —— 否则列表会被推动、抖一下。
  const flash = (text: string): void => showFloat(text)
  const fail = (err: unknown): void => showFloat(err instanceof Error ? err.message : String(err), 'error')

  const paste = async (dir: string): Promise<void> => {
    const c = remoteClipboard.get()
    if (c === null || c.hostId !== opts.hostId) return
    try {
      const r = await opts.api.call('sftpCopy', { hostId: opts.hostId, source: c.path, targetDir: dir })
      opts.reloadDir(dir)
      opts.onPasted?.(dir, r.path)
      flash(t('ctx.pasted', { name: r.path.slice(r.path.lastIndexOf('/') + 1) }))
    } catch (err) {
      fail(err)
    }
  }

  const copyPath = (text: string): void => {
    void copyText(text).then(() => flash(t('ctx.copiedPath')), fail)
  }

  const canPaste = (): boolean => {
    const c = remoteClipboard.get()
    return c !== null && c.hostId === opts.hostId
  }

  const openFor = (e: ReactMouseEvent, path: string, isDir: boolean): void => {
    const rel = relativeTo(opts.root, path)
    if (!opts.editable) {
      open(e, [{ id: 'rel', label: t('ctx.copyRel') }], () => copyPath(rel))
      return
    }
    const items: MenuItem[] = [
      { id: 'rename', label: t('ctx.rename') },
      { id: 'copy', label: t('ctx.copy') },
      { id: 'paste', label: t('ctx.paste'), disabled: !canPaste() },
      { type: 'separator' },
      { id: 'rel', label: t('ctx.copyRel') },
      { id: 'abs', label: t('ctx.copyAbs') }
    ]
    open(e, items, (id) => {
      if (id === 'rename') {
            setRenaming(path)
      }
      if (id === 'copy') {
        remoteClipboard.set({ hostId: opts.hostId, path, isDir })
        flash(t('ctx.copiedItem', { name: path.slice(path.lastIndexOf('/') + 1) }))
      }
      if (id === 'paste') void paste(isDir ? path : parentOf(path))
      if (id === 'rel') copyPath(rel)
      if (id === 'abs') copyPath(path)
    })
  }

  const openForRoot = (e: ReactMouseEvent): void => {
    if (!opts.editable) return
    open(
      e,
      [
        { id: 'paste', label: t('ctx.paste'), disabled: !canPaste() },
        { type: 'separator' },
        { id: 'abs', label: t('ctx.copyAbs') }
      ],
      (id) => {
        if (id === 'paste') void paste(opts.root)
        if (id === 'abs') copyPath(opts.root)
      }
    )
  }

  const submitRename = async (path: string, name: string): Promise<void> => {
    const trimmed = name.trim()
    const old = path.slice(path.lastIndexOf('/') + 1)
    if (trimmed === '' || trimmed === old) {
      setRenaming(null)
      return
    }
    if (trimmed === '.' || trimmed === '..' || trimmed.includes('/')) {
      setRenaming(null)
      fail(new Error(t('dialog.badName')))
      return
    }
    try {
      const r = await opts.api.call('sftpRename', { hostId: opts.hostId, path, name: trimmed })
      setRenaming(null)
      opts.reloadDir(parentOf(path))
      opts.onRenamed?.(path, r.path)
    } catch (err) {
      // 失败时收起输入框并显示原因（输入框只提交一次，留着也无法再提交）。
      setRenaming(null)
      fail(err)
    }
  }

  return { node, openFor, openForRoot, renaming, submitRename, cancelRename: () => setRenaming(null) }
}

/** 行内重命名输入框：回车提交、Esc 取消、失焦提交；打开时选中不含扩展名的部分。 */
export function RenameInput(props: { initial: string; onSubmit(name: string): void; onCancel(): void; paddingLeft: number }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.focus()
    const dot = props.initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const finish = (submit: boolean): void => {
    if (done.current) return
    done.current = true
    if (submit) props.onSubmit(ref.current?.value ?? props.initial)
    else props.onCancel()
  }
  return (
    <div className="dshws-rename" style={{ paddingLeft: props.paddingLeft }}>
      <input
        ref={ref}
        className="dshws-input dshws-rename-input"
        defaultValue={props.initial}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true)
          if (e.key === 'Escape') {
            e.stopPropagation()
            finish(false)
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}
