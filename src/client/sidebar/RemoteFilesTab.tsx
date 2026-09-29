/*
 * @Description: 右侧栏「远程文件」标签 —— 当前远程工作区的 SFTP 文件树，点文件在右侧栏打开；右键菜单（重命名 / 复制 / 粘贴 / 复制路径）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/RemoteFilesTab.tsx
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteEntry } from '../../wire/dto.js'
import { sessionFileAddress } from './remote-index.js'
import { RemoteFileViewer, type SidebarBodyProps } from './RemoteFileTab.js'
import { Split } from './Split.js'
import { RenameInput, useRemoteFileMenu } from './file-menu.js'
import { EmptyState, FileIcon, IconButton, IconChevron, IconEye, IconFile, IconFolder, IconRefresh } from './ui.js'

interface DirState {
  loading: boolean
  entries?: RemoteEntry[]
  error?: string
}

export function RemoteFilesTab(props: SidebarBodyProps) {
  const { t, api, index, sessionId } = props
  const [, setVersion] = useState(0)
  useEffect(() => index.subscribe(() => setVersion((v) => v + 1)), [index])
  const workspace = index.bySession(sessionId)
  // 依赖用字符串而不是 workspace 对象：对象换了但内容没变时不重载。
  const hostId = workspace?.hostId
  const root = workspace?.remotePath
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const wideRef = useRef(false)

  /**
   * 打开文件：够宽就在本页右侧打开；右侧栏里的窄面板维持原来的「新开一个文件标签」；
   * 会话顶部标签（没有标签信息）窄时也在本页打开（整页覆盖列表，✕ 返回）。
   */
  const openFile = (path: string): void => {
    if (!wideRef.current && props.useTabInfo !== undefined) props.openResource(sessionFileAddress(sessionId, path))
    else setSelected(path)
  }

  const loadDir = useCallback(
    async (dir: string) => {
      if (hostId === undefined) return
      setDirs((d) => ({ ...d, [dir]: { ...d[dir], loading: true } }))
      try {
        const r = await api.call('sftpList', { hostId, path: dir })
        setDirs((d) => ({ ...d, [dir]: { loading: false, entries: r.entries } }))
      } catch (err) {
        setDirs((d) => ({ ...d, [dir]: { loading: false, error: err instanceof Error ? err.message : String(err) } }))
      }
    },
    [api, hostId]
  )

  useEffect(() => {
    if (root !== undefined) void loadDir(root)
  }, [loadDir, root])

  const menu = useRemoteFileMenu({
    t,
    api,
    hostId: hostId ?? '',
    root: root ?? '/',
    editable: true,
    reloadDir: (dir) => void loadDir(dir),
    onRenamed: (from, to) => {
      // 打开着的文件（或它所在的目录）被改名：跟着换路径。
      setSelected((cur) => (cur === null ? cur : cur === from ? to : cur.startsWith(`${from}/`) ? to + cur.slice(from.length) : cur))
      setExpanded((cur) => new Set([...cur].map((p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p))))
    },
    onPasted: (dir) => {
      if (dir !== root) setExpanded((cur) => new Set(cur).add(dir))
    }
  })

  if (workspace === undefined || root === undefined) {
    return <div className="dshws-side-note">{t('side.notRemote')}</div>
  }

  const toggle = (dir: string): void => {
    const next = new Set(expanded)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (dirs[dir]?.entries === undefined) void loadDir(dir)
    }
    setExpanded(next)
  }

  const renderDir = (dir: string, depth: number) => {
    const state = dirs[dir]
    if (state === undefined || (state.loading && state.entries === undefined)) {
      return <div className="dshws-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>{t('files.loading')}</div>
    }
    if (state.error !== undefined) {
      return <div className="dshws-tree-note" data-tone="error" style={{ paddingLeft: 12 + depth * 14 }}>{state.error}</div>
    }
    const visible = (state.entries ?? []).filter((e) => showHidden || !e.hidden)
    if (visible.length === 0 && depth === 0) return <EmptyState text={t('add.emptyDir')} />
    return visible.map((e) => {
      const isDir = e.type === 'dir' || e.linkIsDir === true
      const open = expanded.has(e.path)
      return (
        <div key={e.path}>
          {menu.renaming === e.path ? (
            <RenameInput
              initial={e.name}
              paddingLeft={6 + depth * 14}
              onSubmit={(name) => void menu.submitRename(e.path, name)}
              onCancel={menu.cancelRename}
            />
          ) : (
            <button
              type="button"
              className="dshws-row"
              data-ignored={e.ignored}
              data-hidden={e.hidden}
              data-selected={selected === e.path}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={e.path}
              onClick={() => (isDir ? toggle(e.path) : openFile(e.path))}
              onContextMenu={(ev) => menu.openFor(ev, e.path, isDir)}
            >
              <span className="dshws-row-caret">{isDir ? <IconChevron size={12} open={open} /> : null}</span>
              {isDir ? <IconFolder open={open} /> : <FileIcon name={e.name} />}
              <span className="dshws-row-name">{e.name}</span>
              {e.linkTarget !== undefined ? <span className="dshws-row-dim">→ {e.linkTarget}</span> : null}
            </button>
          )}
          {isDir && open ? <div className="dshws-row-children">{renderDir(e.path, depth + 1)}</div> : null}
        </div>
      )
    })
  }

  const list = (
    <div className="dshws-side">
      <div className="dshws-toolbar">
        <IconFolder open />
        <span className="dshws-toolbar-title" title={`${workspace.title}: ${root}`}>
          {workspace.title}
        </span>
        <IconButton title={t('add.showHidden')} active={showHidden} onClick={() => setShowHidden(!showHidden)}>
          <IconEye off={!showHidden} />
        </IconButton>
        <IconButton
          title={t('add.refresh')}
          onClick={() => {
            void loadDir(root)
            for (const d of expanded) void loadDir(d)
          }}
        >
          <IconRefresh />
        </IconButton>
      </div>
      <div className="dshws-subbar dshws-mono" title={root}>
        {root}
      </div>
      <div className="dshws-side-tree" onContextMenu={menu.openForRoot}>
        {renderDir(root, 0)}
      </div>
      {menu.node}
    </div>
  )

  return (
    <Split
      list={list}
      onWideChange={(w) => {
        wideRef.current = w
      }}
      placeholder={<EmptyState icon={<IconFile size={30} />} text={t('side.pickFile')} />}
      detail={
        selected === null ? null : (
          <RemoteFileViewer
            key={selected}
            t={t}
            api={api}
            hostId={workspace.hostId}
            remotePath={selected}
            workspaceTitle={workspace.title}
            onClose={() => setSelected(null)}
          />
        )
      }
    />
  )
}
