/*
 * @Description: 文件夹浏览器 —— 本地与远程共用同一套界面，只换「列目录 / 新建目录」后端
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/workspace/FolderBrowser.tsx
 *
 * 交互：单击文件夹进入；当前所在目录即「选中的目录」。工具栏：上一级 / 起始目录 / 面包屑（可点、可切换为路径输入）/ 刷新。
 * 虚拟目录（如 Windows 的「此电脑」盘符列表）不能作为工作区，进入时上报 undefined。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translate } from '../context.js'
import { IconArrowUp, IconChevron, IconDrive, IconFolder, IconHome, IconPencil, IconRefresh } from '../sidebar/ui.js'

export interface FolderEntry {
  name: string
  path: string
  hidden: boolean
  /** 行图标：盘符用硬盘图标。 */
  kind?: 'dir' | 'drive'
}

export interface FolderCrumb {
  name: string
  path: string
}

export interface FolderListing {
  path: string
  /** 上一级目录；已在根时为 undefined。 */
  parent: string | undefined
  /** 从根到当前目录的祖先链（含当前目录），每一段都可点击跳转。 */
  crumbs: FolderCrumb[]
  entries: FolderEntry[]
  truncated: boolean
  /** 虚拟目录（如盘符列表）：可浏览，但不能选作工作区。 */
  virtual?: boolean
}

export interface FolderBackend {
  /** path 为 undefined 时列起始目录（家目录）。 */
  list(path: string | undefined, signal: AbortSignal): Promise<FolderListing>
  mkdir?(parent: string, name: string): Promise<string>
}

export interface FolderBrowserProps {
  t: Translate
  backend: FolderBackend
  /** 首次打开的目录；缺省为起始目录。后端或起点变化时用新 key 重建组件。 */
  initialPath?: string
  showHidden: boolean
  onPathChange(path: string | undefined): void
  /** 出错时的额外处理（如保险箱锁定时显示解锁框）；返回 true 表示已处理，不再显示错误文字。 */
  onError?(error: unknown): boolean
  /** 由外层（弹窗底栏）触发「新建文件夹」：递增即打开输入框。 */
  mkdirRequest?: number
  /** 首次加载时的提示（如远程主机「正在连接…」）；缺省为「加载中」。 */
  loadingLabel?: string
  /** 出错时显示「重试」按钮（重试当前目录，未加载过则重试起始目录）。 */
  retryable?: boolean
}

export function FolderBrowser(props: FolderBrowserProps) {
  const { t } = props
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [typed, setTyped] = useState('')
  const [creating, setCreating] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const crumbRef = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props

  const load = useCallback(async (target: string | undefined) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const next = await latest.current.backend.list(target, controller.signal)
      if (controller.signal.aborted) return
      setListing(next)
      setTyped(next.virtual === true ? '' : next.path)
      setEditing(false)
      latest.current.onPathChange(next.virtual === true ? undefined : next.path)
    } catch (err) {
      if (controller.signal.aborted) return
      if (latest.current.onError?.(err) !== true) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(props.initialPath)
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // 面包屑过长时滚到末尾，保证当前目录可见。
  useEffect(() => {
    const el = crumbRef.current
    if (el !== null) el.scrollLeft = el.scrollWidth
  }, [listing])

  useEffect(() => {
    if ((props.mkdirRequest ?? 0) > 0 && listing !== null && listing.virtual !== true) setCreating('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mkdirRequest])

  const submitMkdir = async (): Promise<void> => {
    const name = (creating ?? '').trim()
    if (listing === null || props.backend.mkdir === undefined || name === '') return
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      setError(t('dialog.badName'))
      return
    }
    try {
      const created = await props.backend.mkdir(listing.path, name)
      setCreating(null)
      await load(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const submitTyped = (): void => {
    const value = typed.trim()
    void load(value === '' ? undefined : value)
  }

  const entries = (listing?.entries ?? []).filter((e) => props.showHidden || !e.hidden)

  return (
    <div className="dshws-fb">
      <div className="dshws-fb-bar">
        <button
          type="button"
          className="dshws-ibtn"
          title={t('add.up')}
          aria-label={t('add.up')}
          disabled={listing?.parent === undefined || loading}
          onClick={() => void load(listing?.parent)}
        >
          <IconArrowUp size={15} />
        </button>
        <button type="button" className="dshws-ibtn" title={t('add.home')} aria-label={t('add.home')} disabled={loading} onClick={() => void load(undefined)}>
          <IconHome size={15} />
        </button>
        {editing ? (
          <input
            className="dshws-input dshws-mono dshws-fb-path"
            value={typed}
            autoFocus
            spellCheck={false}
            placeholder={t('add.pathPlaceholder')}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTyped()
              if (e.key === 'Escape') {
                // 只收起输入框，不关掉整个弹窗。
                e.stopPropagation()
                setEditing(false)
                setTyped(listing?.virtual === true ? '' : (listing?.path ?? ''))
              }
            }}
          />
        ) : (
          <div className="dshws-fb-crumbs" ref={crumbRef} onDoubleClick={() => setEditing(true)} title={listing?.virtual === true ? undefined : listing?.path}>
            {(listing?.crumbs ?? []).map((c, i, all) => (
              <span key={c.path} className="dshws-fb-crumb-seat">
                {i > 0 ? <IconChevron size={12} /> : null}
                <button
                  type="button"
                  className="dshws-fb-crumb"
                  data-current={i === all.length - 1}
                  disabled={loading}
                  onClick={() => void load(c.path)}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
        )}
        <button type="button" className="dshws-ibtn" title={t('add.editPath')} aria-label={t('add.editPath')} data-active={editing} onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(!editing)}>
          <IconPencil size={14} />
        </button>
        <button type="button" className="dshws-ibtn" title={t('add.refresh')} aria-label={t('add.refresh')} disabled={loading} onClick={() => void load(listing?.path)}>
          <IconRefresh size={14} />
        </button>
      </div>

      {creating !== null ? (
        <div className="dshws-fb-mkdir">
          <IconFolder size={16} />
          <input
            className="dshws-input"
            autoFocus
            value={creating}
            placeholder={t('add.newFolderName')}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitMkdir()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setCreating(null)
              }
            }}
          />
          <button type="button" className="dshws-link-btn" onClick={() => void submitMkdir()}>
            {t('common.confirm')}
          </button>
          <button type="button" className="dshws-link-btn" onClick={() => setCreating(null)}>
            {t('form.cancel')}
          </button>
        </div>
      ) : null}

      <div className="dshws-fb-list" role="listbox" data-loading={loading}>
        {loading && listing === null ? (
          <div className="dshws-fb-connecting">
            <span className="dshws-spinner" aria-hidden="true" />
            <span>{props.loadingLabel ?? t('files.loading')}</span>
          </div>
        ) : null}
        {error !== null ? (
          <div className="dshws-fb-note" data-tone="error">
            {error}
            {props.retryable === true ? (
              <div>
                <button type="button" className="dshws-link-btn" onClick={() => void load(listing?.path ?? props.initialPath)}>
                  {t('add.retry')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {listing !== null && entries.length === 0 && !loading && error === null ? <div className="dshws-fb-note">{t('add.emptyDir')}</div> : null}
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            role="option"
            aria-selected={false}
            className="dshws-fb-item"
            data-hidden={entry.hidden}
            onClick={() => void load(entry.path)}
            title={entry.path}
          >
            <span className="dshws-fb-item-ico" data-kind={entry.kind ?? 'dir'}>
              {entry.kind === 'drive' ? <IconDrive size={16} /> : <IconFolder size={16} />}
            </span>
            <span className="dshws-fb-item-name">{entry.name}</span>
            <IconChevron size={12} />
          </button>
        ))}
        {listing?.truncated === true ? <div className="dshws-fb-note">{t('add.truncated')}</div> : null}
      </div>
    </div>
  )
}

/** Windows 盘符列表（「此电脑」）的虚拟路径。不会与真实路径冲突：真实路径不含 `::`。 */
export const DRIVES = '::drives'

/** 是否是 Windows 路径（盘符开头或含反斜杠）。 */
export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.includes('\\')
}

/** 本机路径的上一级（Windows 与 POSIX 都处理）；已在根返回 undefined。 */
export function localParent(p: string): string | undefined {
  const trimmed = p.replace(/[\\/]+$/, '')
  if (/^[a-zA-Z]:$/.test(trimmed) || trimmed === '') return undefined
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (idx === -1) return undefined
  const parent = trimmed.slice(0, idx)
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`
  return parent === '' ? '/' : parent
}

/** 本机路径的祖先链（宿主没给 crumbs 时兜底）：`C:\a\b` → `C:\`、`C:\a`、`C:\a\b`。 */
export function localCrumbs(p: string): FolderCrumb[] {
  const out: FolderCrumb[] = []
  let cur: string | undefined = p
  while (cur !== undefined) {
    out.unshift({ name: localParent(cur) === undefined ? cur : lastSegment(cur), path: cur })
    cur = localParent(cur)
  }
  return out
}

/** 远程（POSIX）路径的上一级。 */
export function remoteParent(p: string): string | undefined {
  if (p === '/' || p === '') return undefined
  const idx = p.replace(/\/+$/, '').lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

/** 远程（POSIX）路径的祖先链：`/home/ps` → `/`、`/home`、`/home/ps`。 */
export function remoteCrumbs(p: string): FolderCrumb[] {
  const parts = p.split('/').filter((s) => s !== '')
  const out: FolderCrumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    out.push({ name: part, path: acc })
  }
  return out
}

/** 路径最后一段（工作区默认名称）。 */
export function lastSegment(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}
