/*
 * @Description: 右侧栏「远程文件」查看器 —— 远程会话里点开的文件经 SFTP 读取，Monaco 编辑，HTML / 图片可预览
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/RemoteFileTab.tsx
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { RemoteCallError } from '../api.js'
import { ERROR_CODES } from '../../wire/contract.js'
import type { ReadResult } from '../../wire/dto.js'
import { CodeEditor } from '../files/CodeEditor.js'
import type { RemoteIndex } from './remote-index.js'
import { directoryHref, markdownDocument } from './markdown.js'
import { isLight, resolveColor } from '../terminal/theme.js'
import { FileIcon, IconButton, IconClose, IconRefresh } from './ui.js'

export interface SidebarTabInfo {
  tab: { id: string; kind: string; title: string; contentId: string; visible?: boolean; navigation?: { params?: unknown } }
}

export interface SidebarBodyProps {
  t: Translate
  api: WorkspaceApi
  index: RemoteIndex
  /** 在右侧栏打开一个文件地址。 */
  openResource(address: string): void
  sessionId: string
  /** 右侧栏标签才有；会话顶部标签没有。 */
  useTabInfo?(): SidebarTabInfo
}

const MARKDOWN = /\.(md|markdown|mdx)$/i
const PREVIEWABLE = /\.(html?|svg|md|markdown|mdx)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 与本插件同一个版本号的索引刷新计数：远程工作区列表更新后重新解析地址。 */
function useIndexVersion(index: RemoteIndex): number {
  const [v, setV] = useState(0)
  useEffect(() => index.subscribe(() => setV((x) => x + 1)), [index])
  return v
}

/** 右侧栏文件标签：解析地址后交给查看器。 */
export function RemoteFileTab(props: SidebarBodyProps) {
  const { t, api, index } = props
  const info = (props.useTabInfo as () => SidebarTabInfo)()
  useIndexVersion(index)
  const resolved = index.resolveAddress(info.tab.contentId)
  if (resolved === undefined) return <div className="dshws-side-note">{t('side.notRemote')}</div>
  return (
    <RemoteFileViewer
      key={`${resolved.workspace.hostId}:${resolved.remotePath}`}
      t={t}
      api={api}
      hostId={resolved.workspace.hostId}
      remotePath={resolved.remotePath}
      workspaceTitle={resolved.workspace.title}
    />
  )
}

export interface RemoteFileViewerProps {
  t: Translate
  api: WorkspaceApi
  hostId: string
  remotePath: string
  workspaceTitle: string
  /** 嵌在分栏右侧时提供：显示关闭按钮。 */
  onClose?(): void
  /** 保存成功后通知（Git 面板据此刷新改动列表）。 */
  onSaved?(): void
}

/** 远程文件查看 / 编辑器（右侧栏标签与分栏右侧共用）。 */
export function RemoteFileViewer(props: RemoteFileViewerProps) {
  const { t, api, hostId, remotePath } = props

  const [file, setFile] = useState<ReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [mode, setMode] = useState<'code' | 'preview'>(() =>
    remotePath !== undefined && (IMAGE.test(remotePath) || MARKDOWN.test(remotePath)) ? 'preview' : 'code'
  )
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const saveRef = useRef<(() => Promise<void>) | null>(null)

  const load = useCallback(async () => {
    if (hostId === undefined || remotePath === undefined) return
    setLoading(true)
    setError(null)
    try {
      setFile(await api.call('sftpRead', { hostId, path: remotePath }))
      setEditorKey((k) => k + 1)
      setDirty(false)
      setConflict(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [api, hostId, remotePath])

  useEffect(() => {
    if (remotePath !== undefined && IMAGE.test(remotePath)) return
    void load()
  }, [load, remotePath])

  // 预览地址按需签发（令牌绑定该工作区根目录）。
  useEffect(() => {
    if (mode !== 'preview' || hostId === undefined || remotePath === undefined) return
    let alive = true
    api.call('previewUrl', { hostId, path: remotePath }).then(
      (r) => alive && setPreviewSrc(r.url),
      (err: unknown) => alive && setError(messageOf(err))
    )
    return () => {
      alive = false
    }
  }, [api, hostId, mode, remotePath])

  const save = async (value: string, force = false): Promise<void> => {
    if (hostId === undefined || remotePath === undefined || file === null) return
    try {
      const saved = await api.call('sftpWrite', {
        hostId,
        path: remotePath,
        content: value,
        ...(force ? {} : { expectedMtime: file.mtime })
      })
      // 内容一并更新：Markdown 预览直接用它渲染，保存后切到预览看到的就是新内容。
      setFile({ ...file, content: value, mtime: saved.mtime, size: saved.size })
      setConflict(null)
      setPreviewNonce((n) => n + 1)
      props.onSaved?.()
    } catch (err) {
      if (err instanceof RemoteCallError && err.code === ERROR_CODES.conflict) setConflict(value)
      else setError(messageOf(err))
      throw err
    }
  }

  const name = remotePath.slice(remotePath.lastIndexOf('/') + 1)
  const canPreview = PREVIEWABLE.test(name) || IMAGE.test(name)
  const editable = file !== null && !file.binary && !file.truncated && !file.lossy

  return (
    <div className="dshws-side">
      <div className="dshws-toolbar">
        <FileIcon name={name} />
        <span className="dshws-toolbar-title" title={`${props.workspaceTitle}: ${remotePath}`}>
          {name}
          {dirty ? <span className="dshws-dirty" title={t('editor.saveHint')}> ●</span> : null}
        </span>
        {canPreview && !IMAGE.test(name) ? (
          <span className="dshws-side-seg">
            <button type="button" data-active={mode === 'code'} onClick={() => setMode('code')}>
              {t('side.code')}
            </button>
            <button type="button" data-active={mode === 'preview'} onClick={() => setMode('preview')}>
              {t('side.preview')}
            </button>
          </span>
        ) : null}
        {mode === 'code' && editable ? (
          <button type="button" className="dshws-link-btn" disabled={!dirty} onClick={() => void saveRef.current?.().catch(() => undefined)}>
            {t('form.save')}
          </button>
        ) : null}
        <IconButton title={t('editor.reload')} onClick={() => void load().then(() => setPreviewNonce((n) => n + 1))}>
          <IconRefresh />
        </IconButton>
        {props.onClose !== undefined ? (
          <IconButton title={t('common.close')} onClick={props.onClose}>
            <IconClose />
          </IconButton>
        ) : null}
      </div>
      <div className="dshws-subbar dshws-mono" title={remotePath}>
        {remotePath}
      </div>
      {conflict !== null ? (
        <div className="dshws-side-banner" data-tone="warn">
          {t('editor.conflictTitle')}
          <button type="button" className="dshws-link-btn" onClick={() => void save(conflict, true).catch(() => undefined)}>
            {t('editor.overwrite')}
          </button>
          <button type="button" className="dshws-link-btn" onClick={() => void load()}>
            {t('editor.reload')}
          </button>
        </div>
      ) : null}
      {error !== null ? (
        <div className="dshws-tree-note" data-tone="error">
          {error}
        </div>
      ) : null}

      {mode === 'preview' ? (
        previewSrc === null ? (
          <div className="dshws-tree-note">{t('files.loading')}</div>
        ) : MARKDOWN.test(name) ? (
          file === null ? (
            <div className="dshws-tree-note">{t('files.loading')}</div>
          ) : (
            // 无 allow-scripts / allow-same-origin：Markdown 里夹带的 HTML 只能显示，不能执行。
            <iframe
              key={previewNonce}
              className="dshws-side-frame"
              title={name}
              sandbox=""
              srcDoc={markdownDocument(file.content, directoryHref(previewSrc, window.location.origin), !isLight(resolveColor('var(--dsw-alias-bg-layer-1)', '#ffffff')))}
            />
          )
        ) : IMAGE.test(name) ? (
          <div className="dshws-side-image">
            <img src={`${previewSrc}?v=${previewNonce}`} alt={name} />
          </div>
        ) : (
          // 沙箱无 allow-same-origin：预览页是不透明源，碰不到 DSH 界面；样式脚本经预览路由按正确类型返回。
          <iframe
            key={previewNonce}
            className="dshws-side-frame"
            title={name}
            src={previewSrc}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
          />
        )
      ) : loading && file === null ? (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      ) : file === null ? null : file.binary ? (
        <div className="dshws-tree-note">{t('files.binary')}</div>
      ) : (
        <>
          {file.truncated ? <div className="dshws-tree-note" data-tone="warn">{t('side.truncated')}</div> : null}
          {file.lossy ? <div className="dshws-tree-note" data-tone="warn">{t('editor.lossy')}</div> : null}
          <CodeEditor
            key={`${remotePath}#${editorKey}`}
            t={t}
            path={remotePath}
            content={file.content}
            readOnly={!editable}
            onDirtyChange={setDirty}
            fetchAsset={(assetName, i) => api.call('editorAsset', { name: assetName, index: i })}
            onSave={(value) => save(value)}
            registerSave={(fn) => {
              saveRef.current = fn
            }}
          />
        </>
      )}
    </div>
  )
}
