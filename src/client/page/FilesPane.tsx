/*
 * @Description: 远端文件浏览 —— 懒加载目录树 + 预览 + 行菜单 + 拖拽上传 + 文件名搜索
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/FilesPane.tsx
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostView } from '../../types.js'
import type { ListResult, ReadResult, RemoteEntry, SearchResult } from '../../wire/dto.js'
import { ERROR_CODES } from '../../wire/contract.js'
import type { Translate } from '../context.js'
import { IconChevronDown, IconRefresh } from '../icons.js'
import { RemoteCallError } from '../api.js'
import {
  TransferError,
  baseName,
  crumbs,
  formatMode,
  formatSize,
  joinPath,
  parentOf,
  startDownload,
  uploadFile,
  type UploadHandle
} from '../files/transfer.js'
import { messageOf, type WorkspaceModel } from './useWorkspace.js'
import { fileNameProblem, useDialogs } from './dialogs.js'
import { CodeEditor } from '../files/CodeEditor.js'
import { EmptyState, FileIcon, IconArrowUp, IconDoc, IconFolder, IconSubmodule } from '../sidebar/ui.js'

export interface FilesPaneProps {
  t: Translate
  model: WorkspaceModel
  hosts: HostView[]
  hostId: string | null
  onHostChange: (id: string) => void
  onOpenTerminal: (hostId: string, cwd: string) => void
  notify: (text: string) => void
}

/** 一个目录的加载状态。 */
interface DirState {
  loading: boolean
  entries?: RemoteEntry[]
  truncated?: boolean
  error?: string
}

interface UploadItem {
  id: number
  name: string
  dir: string
  loaded: number
  total: number
  status: 'uploading' | 'done' | 'error'
  message?: string
  handle?: UploadHandle
}

let uploadSeq = 0

export function FilesPane(props: FilesPaneProps) {
  const { t, hostId } = props
  const call = props.model.call
  const requestUnlock = props.model.requestUnlock
  const dialogs = useDialogs()
  const badName = fileNameProblem(t)

  const [root, setRoot] = useState<string | null>(null)
  const [pathDraft, setPathDraft] = useState('')
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<RemoteEntry | null>(null)
  const [preview, setPreview] = useState<{ path: string; loading: boolean; result?: ReadResult; error?: string } | null>(null)
  /** 编辑器有未保存修改。 */
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 每次（重新）读入文件递增，用作编辑器的 key：内容变了就重建编辑器。 */
  const [editorKey, setEditorKey] = useState(0)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ loading: boolean; result?: SearchResult; error?: string } | null>(null)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadDir = useRef<string>('/')
  /** 切换主机后丢弃旧主机的迟到响应。 */
  const hostRef = useRef(hostId)
  hostRef.current = hostId

  // ---------------------------------------------------------------- 加载

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      if (hostId === null) return
      const forHost = hostId
      setDirs((prev) => ({ ...prev, [dir]: { ...prev[dir], loading: true } }))
      try {
        const result: ListResult = await call('sftpList', { hostId: forHost, path: dir })
        if (hostRef.current !== forHost) return
        setDirs((prev) => ({
          ...prev,
          [dir]: { loading: false, entries: result.entries, truncated: result.truncated }
        }))
      } catch (error) {
        if (hostRef.current !== forHost) return
        setDirs((prev) => ({ ...prev, [dir]: { loading: false, error: messageOf(error) } }))
      }
    },
    [call, hostId]
  )

  // 切换主机：清空视图，定位到家目录。
  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setSelected(null)
    setPreview(null)
    setSearch(null)
    setQuery('')
    setRoot(null)
    if (hostId === null) return
    const forHost = hostId
    call('sftpHome', { hostId: forHost })
      .then(({ path }) => {
        if (hostRef.current === forHost) setRoot(path)
      })
      .catch((error: unknown) => {
        if (hostRef.current !== forHost) return
        // 取不到家目录（如保险箱锁定）时退到根目录，错误会显示在根目录的加载结果里。
        setRoot('/')
        if (!(error instanceof RemoteCallError && error.code === ERROR_CODES.vaultLocked)) {
          props.notify(t('error.generic', { message: messageOf(error) }))
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, call])

  useEffect(() => {
    if (root === null) return
    setPathDraft(root)
    setExpanded(new Set())
    if (dirs[root] === undefined) void loadDir(root)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  const refreshDir = (dir: string): void => {
    void loadDir(dir)
  }

  const toggle = (entry: RemoteEntry): void => {
    const next = new Set(expanded)
    if (next.has(entry.path)) next.delete(entry.path)
    else {
      next.add(entry.path)
      if (dirs[entry.path] === undefined || dirs[entry.path]?.error !== undefined) void loadDir(entry.path)
    }
    setExpanded(next)
  }

  /** 有未保存修改时先确认，避免点错文件就丢掉编辑内容。 */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true
    return dialogs.confirm({ title: t('editor.unsavedTitle'), message: t('editor.unsaved'), confirmLabel: t('editor.discard'), danger: true })
  }

  const openPreview = async (entry: RemoteEntry, options: { force?: boolean } = {}): Promise<void> => {
    if (hostId === null) return
    if (options.force !== true && preview?.path !== entry.path && !(await confirmDiscard())) return
    setSelected(entry)
    setDirty(false)
    setPreview({ path: entry.path, loading: true })
    try {
      const result = await call('sftpRead', { hostId, path: entry.path })
      setEditorKey((k) => k + 1)
      setPreview((cur) => (cur?.path === entry.path ? { path: entry.path, loading: false, result } : cur))
    } catch (error) {
      setPreview((cur) => (cur?.path === entry.path ? { path: entry.path, loading: false, error: messageOf(error) } : cur))
    }
  }

  /**
   * 保存编辑器内容。带上打开时的修改时间：远端在此期间被改过（终端里、别的会话里）
   * 就返回冲突，由用户决定是否覆盖 —— 而不是静默盖掉别人的修改。
   */
  const saveFile = async (value: string, force = false): Promise<void> => {
    if (hostId === null || preview?.result === undefined) return
    const path = preview.path
    setSaving(true)
    try {
      const saved = await call('sftpWrite', {
        hostId,
        path,
        content: value,
        ...(force ? {} : { expectedMtime: preview.result.mtime })
      })
      // 只更新元数据，不重建编辑器（光标、撤销栈都保留）。
      setPreview((cur) =>
        cur?.path === path && cur.result !== undefined
          ? { ...cur, result: { ...cur.result, mtime: saved.mtime, size: saved.size } }
          : cur
      )
      props.notify(t('editor.saved'))
      refreshDir(parentOf(path))
    } catch (error) {
      if (error instanceof RemoteCallError && error.code === ERROR_CODES.conflict) {
        const overwrite = await dialogs.confirm({
          title: t('editor.conflictTitle'),
          message: t('editor.conflict', { path }),
          confirmLabel: t('editor.overwrite'),
          danger: true
        })
        if (overwrite) return await saveFile(value, true)
      } else {
        props.notify(t('error.generic', { message: messageOf(error) }))
      }
      // 抛出让编辑器保持「未保存」状态。
      throw error
    } finally {
      setSaving(false)
    }
  }

  const reloadPreview = async (): Promise<void> => {
    if (selected === null || !(await confirmDiscard())) return
    await openPreview(selected, { force: true })
  }

  const isDir = (e: RemoteEntry): boolean => e.type === 'dir' || e.linkIsDir === true

  // ---------------------------------------------------------------- 操作

  const act = async (fn: () => Promise<unknown>, refresh: string[]): Promise<void> => {
    try {
      await fn()
      for (const d of refresh) refreshDir(d)
    } catch (error) {
      props.notify(t('error.generic', { message: messageOf(error) }))
    }
  }

  const mkdir = async (dir: string): Promise<void> => {
    if (hostId === null) return
    const name = await dialogs.prompt({ title: t('files.newFolder'), label: t('files.newFolderPrompt'), validate: badName })
    if (name === null) return
    await act(() => call('sftpMkdir', { hostId, parent: dir, name }), [dir])
    expandPath(dir)
  }

  const createFile = async (dir: string): Promise<void> => {
    if (hostId === null) return
    const name = await dialogs.prompt({ title: t('files.newFile'), label: t('files.newFilePrompt'), validate: badName })
    if (name === null) return
    await act(async () => {
      const { path } = await call('sftpCreateFile', { hostId, parent: dir, name })
      // 新建后直接在编辑器里打开，省一次点击。
      void openPreview({ name, path, type: 'file', size: 0, mtime: Date.now(), mode: 0, ignored: false, hidden: name.startsWith('.') })
    }, [dir])
    expandPath(dir)
  }

  const rename = async (entry: RemoteEntry): Promise<void> => {
    if (hostId === null) return
    const name = await dialogs.prompt({
      title: t('files.rename'),
      label: t('files.renamePrompt'),
      defaultValue: entry.name,
      selectBaseName: !isDir(entry),
      validate: badName
    })
    if (name === null || name === entry.name) return
    await act(() => call('sftpRename', { hostId, path: entry.path, name }), [parentOf(entry.path)])
  }

  const remove = async (entry: RemoteEntry): Promise<void> => {
    if (hostId === null) return
    const message = isDir(entry) && entry.type === 'dir'
      ? t('files.deleteDirConfirm', { path: entry.path })
      : t('files.deleteConfirm', { path: entry.path })
    const ok = await dialogs.confirm({ title: t('files.delete'), message, confirmLabel: t('files.delete'), danger: true })
    if (!ok) return
    void act(async () => {
      const result = await call('sftpRemove', { hostId, path: entry.path })
      props.notify(t('files.deleted', { files: result.files, dirs: result.dirs }))
      if (selected?.path === entry.path) {
        setSelected(null)
        setPreview(null)
      }
    }, [parentOf(entry.path)])
  }

  const copyPath = (p: string): void => {
    void navigator.clipboard?.writeText(p).then(() => props.notify(t('common.copied')))
  }

  const expandPath = (dir: string): void => {
    if (dir === root) return
    setExpanded((prev) => new Set(prev).add(dir))
  }

  // ---------------------------------------------------------------- 上传

  const startUpload = (files: FileList | File[], dir: string, overwrite = false): void => {
    if (hostId === null) return
    const forHost = hostId
    for (const file of Array.from(files)) {
      uploadSeq += 1
      const id = uploadSeq
      const handle = uploadFile(file, { hostId: forHost, dir, name: file.name, overwrite }, (loaded, total) =>
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, loaded, total } : u)))
      )
      setUploads((prev) => [
        ...prev,
        { id, name: file.name, dir, loaded: 0, total: file.size, status: 'uploading', handle }
      ])
      handle.promise
        .then(() => {
          setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'done', loaded: u.total } : u)))
          refreshDir(dir)
        })
        .catch((error: unknown) => {
          // 同名文件：询问是否覆盖，同意则以覆盖模式重传这一个文件。
          if (error instanceof TransferError && error.isExists) {
            setUploads((prev) => prev.filter((u) => u.id !== id))
            void dialogs
              .confirm({ title: t('files.upload'), message: t('files.overwriteConfirm', { name: file.name }) })
              .then((ok) => {
                if (ok) startUpload([file], dir, true)
              })
            return
          }
          if (error instanceof TransferError && error.isLocked) requestUnlock()
          setUploads((prev) =>
            prev.map((u) => (u.id === id ? { ...u, status: 'error', message: messageOf(error) } : u))
          )
        })
    }
  }

  const pickUpload = (dir: string): void => {
    uploadDir.current = dir
    uploadInput.current?.click()
  }

  const onDrop = (event: DragEvent, dir: string): void => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    if (event.dataTransfer.files.length > 0) {
      startUpload(event.dataTransfer.files, dir)
      expandPath(dir)
    }
  }

  const dragProps = (dir: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      setDropTarget(dir)
    },
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation()
      setDropTarget((cur) => (cur === dir ? null : cur))
    },
    onDrop: (event: DragEvent) => onDrop(event, dir)
  })

  // ---------------------------------------------------------------- 搜索

  const runSearch = async (): Promise<void> => {
    const q = query.trim()
    if (q === '' || hostId === null || root === null) {
      setSearch(null)
      return
    }
    setSearch({ loading: true })
    try {
      const result = await call('sftpSearch', { hostId, root, query: q })
      setSearch({ loading: false, result })
    } catch (error) {
      setSearch({ loading: false, error: messageOf(error) })
    }
  }

  const openSearchHit = (hit: { path: string; type: 'dir' | 'file' }): void => {
    if (hit.type === 'dir') {
      setSearch(null)
      setQuery('')
      setRoot(hit.path)
      return
    }
    const entry: RemoteEntry = {
      name: baseName(hit.path),
      path: hit.path,
      type: 'file',
      size: 0,
      mtime: 0,
      mode: 0,
      ignored: false,
      hidden: baseName(hit.path).startsWith('.')
    }
    void openPreview(entry)
  }

  // ---------------------------------------------------------------- 渲染

  const visible = useCallback(
    (entries: RemoteEntry[] | undefined): RemoteEntry[] =>
      (entries ?? []).filter((e) => showHidden || !e.hidden),
    [showHidden]
  )

  const menuItems = (entry: RemoteEntry) => {
    const dir = isDir(entry)
    return [
      { id: 'terminal', label: t('files.openTerminalHere') },
      ...(dir
        ? [
            { id: 'upload', label: t('files.uploadHere') },
            { id: 'mkdir', label: t('files.newFolder') },
            { id: 'touch', label: t('files.newFile') },
            { id: 'root', label: t('files.enter') }
          ]
        : [{ id: 'download', label: t('files.download') }]),
      { type: 'separator' as const },
      { id: 'rename', label: t('files.rename') },
      { id: 'copy', label: t('files.copyPath') },
      { type: 'separator' as const },
      { id: 'delete', label: t('files.delete'), danger: true }
    ]
  }

  const onMenu = (entry: RemoteEntry, id: string): void => {
    setMenuFor(null)
    if (hostId === null) return
    const dir = isDir(entry) ? entry.path : parentOf(entry.path)
    if (id === 'terminal') props.onOpenTerminal(hostId, dir)
    if (id === 'upload') pickUpload(entry.path)
    if (id === 'mkdir') mkdir(entry.path)
    if (id === 'touch') createFile(entry.path)
    if (id === 'root') setRoot(entry.path)
    if (id === 'download') startDownload(hostId, entry.path)
    if (id === 'rename') rename(entry)
    if (id === 'copy') copyPath(entry.path)
    if (id === 'delete') remove(entry)
  }

  const renderEntries = (dir: string, depth: number): JSX.Element => {
    const state = dirs[dir]
    if (state === undefined || (state.loading && state.entries === undefined)) {
      return <div className="dshws-tree-note" style={{ paddingLeft: 12 + depth * 16 }}>{t('files.loading')}</div>
    }
    if (state.error !== undefined) {
      return (
        <div className="dshws-tree-note" data-tone="error" style={{ paddingLeft: 12 + depth * 16 }}>
          {state.error}{' '}
          <button type="button" className="dshws-link" onClick={() => refreshDir(dir)}>
            {t('files.retry')}
          </button>
        </div>
      )
    }
    const list = visible(state.entries)
    return (
      <>
        {list.length === 0 ? (
          <div className="dshws-tree-note" style={{ paddingLeft: 12 + depth * 16 }}>{t('files.emptyDir')}</div>
        ) : null}
        {list.map((entry) => {
          const dirLike = isDir(entry)
          const open = expanded.has(entry.path)
          return (
            <div key={entry.path}>
              <div
                className="dshws-tree-row"
                data-selected={selected?.path === entry.path}
                data-ignored={entry.ignored}
                data-drop={dirLike && dropTarget === entry.path}
                style={{ paddingLeft: 8 + depth * 16 }}
                onClick={() => (dirLike ? toggle(entry) : void openPreview(entry))}
                onDoubleClick={() => (dirLike ? setRoot(entry.path) : undefined)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenuFor(entry.path)
                }}
                title={entry.linkTarget !== undefined ? `${entry.path} → ${entry.linkTarget}` : entry.path}
                {...(dirLike ? dragProps(entry.path) : {})}
              >
                <span className="dshws-tree-caret" data-open={open}>
                  {dirLike ? <IconChevronDown size={12} /> : null}
                </span>
                <span className="dshws-tree-icon">{dirLike ? <IconFolder size={15} open={open} /> : entry.type === 'symlink' ? <IconSubmodule size={15} /> : <FileIcon name={entry.name} />}</span>
                <span className="dshws-tree-name">{entry.name}</span>
                {entry.type === 'symlink' ? <span className="dshws-tree-meta">→ {entry.linkTarget ?? '?'}</span> : null}
                {!dirLike ? <span className="dshws-tree-meta">{formatSize(entry.size)}</span> : null}
                <Menu
                  open={menuFor === entry.path}
                  align="end"
                  portal
                  anchor={
                    <button
                      type="button"
                      className="dshws-tree-more"
                      aria-label={t('common.more')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuFor(menuFor === entry.path ? null : entry.path)
                      }}
                    >
                      ⋯
                    </button>
                  }
                  items={menuItems(entry)}
                  onClose={() => setMenuFor(null)}
                  onSelect={(id) => onMenu(entry, id)}
                />
              </div>
              {dirLike && open ? renderEntries(entry.path, depth + 1) : null}
            </div>
          )
        })}
        {state.truncated === true ? (
          <div className="dshws-tree-note" style={{ paddingLeft: 12 + depth * 16 }}>{t('files.truncated')}</div>
        ) : null}
      </>
    )
  }

  const activeUploads = useMemo(() => uploads.filter((u) => u.status !== 'done'), [uploads])

  if (props.hosts.length === 0) return <div className="dshws-empty">{t('files.noHosts')}</div>

  return (
    <div className="dshws-files">
      <div className="dshws-files-bar">
        <select
          className="dshws-select"
          style={{ width: 200 }}
          value={hostId ?? ''}
          onChange={(e) => props.onHostChange(e.target.value)}
        >
          <option value="" disabled>
            {t('files.pickHost')}
          </option>
          {props.hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </select>

        {root !== null ? (
          <>
            <button type="button" className="dshws-icon-btn" title={t('files.up')} aria-label={t('files.up')} disabled={root === '/'} onClick={() => setRoot(parentOf(root))}>
              <IconArrowUp size={15} />
            </button>
            <form
              className="dshws-files-path"
              onSubmit={(e) => {
                e.preventDefault()
                const next = pathDraft.trim()
                if (next.startsWith('/')) setRoot(next.replace(/\/+$/, '') || '/')
              }}
            >
              <input
                className="dshws-input dshws-mono"
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                aria-label={t('files.path')}
              />
            </form>
            <button type="button" className="dshws-icon-btn" title={t('log.refresh')} onClick={() => refreshDir(root)}>
              <IconRefresh size={14} />
            </button>
          </>
        ) : null}
      </div>

      {root !== null && hostId !== null ? (
        <>
          <div className="dshws-files-bar">
            <div className="dshws-crumbs">
              {crumbs(root).map((c, i) => (
                <span key={c.path}>
                  {i >= 2 ? <span className="dshws-crumb-sep">/</span> : null}
                  <button type="button" className="dshws-link" onClick={() => setRoot(c.path)}>
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
            <form
              className="dshws-files-search"
              onSubmit={(e) => {
                e.preventDefault()
                void runSearch()
              }}
            >
              <input
                className="dshws-input"
                placeholder={t('files.searchPlaceholder')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  if (e.target.value.trim() === '') setSearch(null)
                }}
              />
            </form>
            <label className="dshws-check">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              {t('files.showHidden')}
            </label>
            <Button size="sm" variant="outline" onClick={() => props.onOpenTerminal(hostId, root)}>
              {t('files.terminalHere')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => mkdir(root)}>
              {t('files.newFolder')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => pickUpload(root)}>
              {t('files.upload')}
            </Button>
          </div>

          <div className="dshws-files-body">
            <div
              className="dshws-tree"
              data-drop={dropTarget === root}
              {...dragProps(root)}
            >
              {search !== null ? (
                <div className="dshws-search-results">
                  <div className="dshws-tree-note">
                    {search.loading
                      ? t('files.searching')
                      : search.error !== undefined
                        ? search.error
                        : t('files.searchCount', { count: search.result?.matches.length ?? 0 })}
                    {search.result?.truncated === true ? ` · ${t('files.searchTruncated')}` : ''}
                    {search.result?.timedOut === true ? ` · ${t('files.searchTimeout')}` : ''}{' '}
                    <button
                      type="button"
                      className="dshws-link"
                      onClick={() => {
                        setSearch(null)
                        setQuery('')
                      }}
                    >
                      {t('files.backToTree')}
                    </button>
                  </div>
                  {search.result?.matches.map((hit) => (
                    <div key={hit.path} className="dshws-tree-row" onClick={() => openSearchHit(hit)} title={hit.path}>
                      <span className="dshws-tree-icon">{hit.type === 'dir' ? <IconFolder size={15} /> : <FileIcon name={baseName(hit.path)} />}</span>
                      <span className="dshws-tree-name">{hit.path.startsWith(`${root}/`) ? hit.path.slice(root.length + 1) : hit.path}</span>
                    </div>
                  ))}
                </div>
              ) : (
                renderEntries(root, 0)
              )}
            </div>

            <div className="dshws-preview">
              {preview === null ? (
                <EmptyState icon={<IconDoc size={28} />} text={t('files.previewHint')} />
              ) : preview.loading ? (
                <div className="dshws-tree-note">{t('files.loading')}</div>
              ) : preview.error !== undefined ? (
                <div className="dshws-tree-note" data-tone="error">{preview.error}</div>
              ) : preview.result !== undefined ? (
                <>
                  <div className="dshws-preview-head">
                    <span className="dshws-preview-name" title={preview.path}>
                      {dirty ? <span className="dshws-dirty" title={t('editor.dirty')}>● </span> : null}
                      {baseName(preview.path)}
                    </span>
                    <span className="dshws-tree-meta">
                      {formatSize(preview.result.size)}
                      {selected !== null && selected.path === preview.path && selected.mode !== 0
                        ? ` · ${formatMode(selected.mode)}`
                        : ''}
                      {` · ${new Date(preview.result.mtime).toLocaleString()}`}
                    </span>
                    <button type="button" className="dshws-icon-btn" title={t('editor.reload')} onClick={() => void reloadPreview()}>
                      <IconRefresh size={14} />
                    </button>
                    <Button size="sm" variant="outline" onClick={() => startDownload(hostId, preview.path)}>
                      {t('files.download')}
                    </Button>
                    {!preview.result.binary && !preview.result.truncated && !preview.result.lossy ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!dirty || saving}
                        onClick={() => void saveRef.current?.().catch(() => undefined)}
                      >
                        {saving ? t('form.saving') : t('form.save')}
                      </Button>
                    ) : null}
                  </div>
                  {preview.result.binary ? (
                    <div className="dshws-tree-note">{t('files.binary')}</div>
                  ) : (
                    <>
                      {preview.result.truncated ? (
                        <div className="dshws-tree-note" data-tone="warn">
                          {t('files.previewTruncated', { size: formatSize(preview.result.content.length) })}
                        </div>
                      ) : null}
                      {preview.result.lossy ? (
                        <div className="dshws-tree-note" data-tone="warn">{t('editor.lossy')}</div>
                      ) : null}
                      <CodeEditor
                        key={`${preview.path}#${editorKey}`}
                        t={t}
                        path={preview.path}
                        content={preview.result.content}
                        // 截断或非 UTF-8 的内容保存回去会写坏文件，只读。
                        readOnly={preview.result.truncated || preview.result.lossy}
                        onDirtyChange={setDirty}
                        fetchAsset={(name, index) => call('editorAsset', { name, index })}
                        onSave={(value) => saveFile(value)}
                        registerSave={(save) => {
                          saveRef.current = save
                        }}
                      />
                    </>
                  )}
                </>
              ) : null}
            </div>
          </div>

          {activeUploads.length > 0 ? (
            <div className="dshws-uploads">
              {activeUploads.map((u) => (
                <div key={u.id} className="dshws-upload" data-status={u.status}>
                  <span className="dshws-upload-name" title={joinPath(u.dir, u.name)}>{u.name}</span>
                  {u.status === 'uploading' ? (
                    <>
                      <progress max={Math.max(u.total, 1)} value={u.loaded} />
                      <span className="dshws-tree-meta">
                        {formatSize(u.loaded)} / {formatSize(u.total)}
                      </span>
                      <button type="button" className="dshws-link" onClick={() => u.handle?.abort()}>
                        {t('form.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="dshws-upload-error">{u.message}</span>
                      <button
                        type="button"
                        className="dshws-link"
                        onClick={() => setUploads((prev) => prev.filter((x) => x.id !== u.id))}
                      >
                        {t('common.close')}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : hostId === null ? (
        <div className="dshws-empty">{t('files.pickHostHint')}</div>
      ) : (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      )}

      <input
        ref={uploadInput}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files
          if (files !== null && files.length > 0) {
            startUpload(files, uploadDir.current)
            expandPath(uploadDir.current)
          }
          e.target.value = ''
        }}
      />
    </div>
  )
}
