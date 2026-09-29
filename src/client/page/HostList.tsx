/*
 * @Description: 分组树 + 主机行
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/HostList.tsx
 */
import { useMemo, useState, type DragEvent } from 'react'
import { Menu, StateDot, type StateDotProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown } from '../icons.js'
import { IconButton, IconFolder, IconMore, IconPencil, IconPlus, IconPulse, IconServer, IconTerminal, IconTrash } from '../sidebar/ui.js'
import type { ConnectionStatus, GroupView, HostView } from '../../types.js'
import type { TestConnectionOutput } from '../../wire/dto.js'
import type { Translate } from '../context.js'

export interface TestState {
  running: boolean
  result?: TestConnectionOutput
}

export interface HostListProps {
  t: Translate
  hosts: HostView[]
  groups: GroupView[]
  statuses: ConnectionStatus[]
  query: string
  selectedId: string | null
  tests: Record<string, TestState>
  /** 正在打开终端的主机 id（跳板链上握手可能要一两秒，按钮需要反馈）。 */
  opening: string | null
  onSelect: (id: string) => void
  onTest: (host: HostView) => void
  onOpenTerminal: (host: HostView) => void
  onOpenFiles: (host: HostView) => void
  onEdit: (host: HostView) => void
  onDisconnect: (host: HostView) => void
  onForgetKey: (host: HostView) => void
  onDelete: (host: HostView) => void
  onAddHostInGroup: (path: string) => void
  onEditGroup: (path: string) => void
  onDeleteGroup: (path: string) => void
  /** 拖拽主机到另一个分组（'' = 无分组）。 */
  onMoveHost: (host: HostView, groupPath: string) => void
}

/** 拖拽数据类型：只认本列表发起的拖拽，外部拖进来的文件 / 文字不响应。 */
const DRAG_TYPE = 'application/x-dshws-host'

interface TreeNode {
  path: string
  name: string
  hosts: HostView[]
  children: TreeNode[]
  /** 子树内主机总数（用于分组标题的计数与空分组过滤）。 */
  total: number
}

/**
 * 构建分组树。节点来源有两个：分组记录，以及主机的 groupPath。
 * 只看分组记录会漏掉「主机写了 a/b 但没建 a/b 分组」的情况。
 */
function buildTree(hosts: HostView[], groups: GroupView[]): TreeNode {
  const root: TreeNode = { path: '', name: '', hosts: [], children: [], total: 0 }
  const index = new Map<string, TreeNode>([['', root]])

  const ensure = (path: string): TreeNode => {
    const found = index.get(path)
    if (found !== undefined) return found
    const slash = path.lastIndexOf('/')
    const parent = ensure(slash === -1 ? '' : path.slice(0, slash))
    const node: TreeNode = { path, name: slash === -1 ? path : path.slice(slash + 1), hosts: [], children: [], total: 0 }
    parent.children.push(node)
    index.set(path, node)
    return node
  }

  for (const group of groups) ensure(group.path)
  for (const host of hosts) ensure(host.groupPath).hosts.push(host)

  const finalize = (node: TreeNode): number => {
    node.hosts.sort((a, b) => a.label.localeCompare(b.label))
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.total = node.hosts.length + node.children.reduce((sum, c) => sum + finalize(c), 0)
    return node.total
  }
  finalize(root)
  return root
}

function matches(host: HostView, query: string): boolean {
  if (query === '') return true
  const q = query.toLowerCase()
  return [host.label, host.hostname, host.username ?? '', host.groupPath, host.notes ?? '']
    .some((field) => field.toLowerCase().includes(q))
}

/** 合并终端池与文件池的状态：任一已连接即视为已连接。 */
function dotOf(hostId: string, statuses: ConnectionStatus[]): StateDotProps['state'] {
  const mine = statuses.filter((s) => s.hostId === hostId)
  if (mine.some((s) => s.phase === 'ready')) return 'done'
  if (mine.some((s) => s.phase === 'connecting' || s.phase === 'reconnecting')) return 'ongoing'
  if (mine.some((s) => s.phase === 'error')) return 'error'
  if (mine.some((s) => s.phase === 'locked')) return 'warning'
  return 'idle'
}

export function HostList(props: HostListProps) {
  const { t } = props
  const tree = useMemo(() => buildTree(props.hosts, props.groups), [props.hosts, props.groups])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const groupPaths = useMemo(() => new Set(props.groups.map((g) => g.path)), [props.groups])

  const byId = useMemo(() => new Map(props.hosts.map((h) => [h.id, h])), [props.hosts])

  /** 正在拖的主机与当前悬停的目标分组（'' = 根 / 无分组）。 */
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropPath, setDropPath] = useState<string | null>(null)
  const dragging = dragId !== null ? byId.get(dragId) : undefined

  /** 作为放置目标的事件：内层分组先处理并阻止冒泡，所以落在最近的那个分组上。 */
  const dropProps = (path: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropPath !== path) setDropPath(path)
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      const host = byId.get(e.dataTransfer.getData(DRAG_TYPE))
      setDragId(null)
      setDropPath(null)
      if (host !== undefined && host.groupPath !== path) props.onMoveHost(host, path)
    }
  })

  const renderHost = (host: HostView) => {
    const test = props.tests[host.id]
    const via = host.jumpHostIds.map((id) => byId.get(id)?.label ?? '?')
    const dot = dotOf(host.id, props.statuses)
    const latency = props.statuses.find((s) => s.hostId === host.id && s.phase === 'ready')?.latencyMs
    return (
      <div key={host.id}>
        <div
          className="dshws-host"
          data-selected={props.selectedId === host.id}
          data-state={dot}
          data-dragging={dragId === host.id}
          draggable
          title={t('host.dragHint')}
          onDragStart={(e) => {
            // 从按钮 / 输入框上开始的拖动不算（避免误拖）。
            if ((e.target as HTMLElement).closest('button, input, a') !== null) {
              e.preventDefault()
              return
            }
            e.dataTransfer.setData(DRAG_TYPE, host.id)
            e.dataTransfer.effectAllowed = 'move'
            // 推迟到下一帧再改 DOM：dragstart 里同步插入元素，Chromium 可能直接取消这次拖动。
            setTimeout(() => setDragId(host.id), 0)
          }}
          onDragEnd={() => {
            setDragId(null)
            setDropPath(null)
          }}
        >
          {/* 主机图标 + 右下角状态点：比单独一个小圆点更容易一眼扫到连接状态 */}
          <span className="dshws-host-icon">
            <IconServer size={16} />
            <span className="dshws-host-dot">
              <StateDot state={dot} size={8} />
            </span>
          </span>
          <div className="dshws-host-main" onClick={() => props.onSelect(host.id)}>
            <div className="dshws-host-label">
              <span className="dshws-host-name">{host.label}</span>
              <AuthChip t={t} host={host} />
              {via.length > 0 ? <span className="dshws-chip" data-kind="via">{t('host.via', { name: via.join(' → ') })}</span> : null}
              {host.proxy !== null ? (
                <span className="dshws-chip" data-kind="proxy">
                  {t('host.proxy')} · {host.proxy.kind.toUpperCase()}
                </span>
              ) : null}
            </div>
            <div className="dshws-host-addr">
              <span>
                {host.username !== undefined ? `${host.username}@` : ''}
                {host.hostname}:{host.port}
              </span>
              {dot === 'done' ? <span className="dshws-host-live">{latency !== undefined ? t('host.connectedMs', { ms: latency }) : t('host.connected')}</span> : null}
            </div>
            {test?.result !== undefined ? (
              <div className="dshws-host-result" data-ok={test.result.ok}>
                {test.result.ok
                  ? t('host.testOk', { ms: test.result.latencyMs ?? 0, system: test.result.system ?? '' })
                  : t('host.testFail', { message: test.result.message })}
              </div>
            ) : null}
          </div>
          <div className="dshws-host-actions">
            {/* 每行都放黑色主按钮太重：统一成带图标的次级按钮，页面上只有「新建主机」一个主按钮 */}
            <button type="button" className="dshws-act" disabled={props.opening === host.id} onClick={() => props.onOpenTerminal(host)}>
              <IconTerminal size={14} />
              {props.opening === host.id ? t('host.opening') : t('host.terminal')}
            </button>
            <button type="button" className="dshws-act" onClick={() => props.onOpenFiles(host)}>
              <IconFolder size={14} />
              {t('host.files')}
            </button>
            <button type="button" className="dshws-act" data-ghost="true" disabled={test?.running === true} onClick={() => props.onTest(host)}>
              <IconPulse size={14} />
              {test?.running === true ? t('host.testing') : t('host.test')}
            </button>
            <span className="dshws-host-sep" />
            <IconButton title={t('host.edit')} onClick={() => props.onEdit(host)}>
              <IconPencil size={15} />
            </IconButton>
            <HostMenu {...props} host={host} />
          </div>
        </div>
      </div>
    )
  }

  const renderNode = (node: TreeNode, depth: number): JSX.Element | null => {
    const visibleHosts = node.hosts.filter((h) => matches(h, props.query))
    const childElements = node.children
      .map((child) => renderNode(child, depth + 1))
      .filter((e): e is JSX.Element => e !== null)

    // 搜索时隐藏没有命中的分组；不搜索时保留空分组，方便往里加主机。
    if (props.query !== '' && visibleHosts.length === 0 && childElements.length === 0) return null

    const body = (
      <>
        {visibleHosts.map(renderHost)}
        {childElements}
      </>
    )
    if (depth === 0) return body

    const open = props.query !== '' || collapsed[node.path] !== true
    const isRecord = groupPaths.has(node.path)
    return (
      <div
        className="dshws-group"
        key={node.path}
        data-drop={dragging !== undefined && dropPath === node.path}
        data-drop-same={dragging !== undefined && dropPath === node.path && dragging.groupPath === node.path}
        {...dropProps(node.path)}
      >
        <div
          className="dshws-group-head"
          data-open={open}
          onClick={() => setCollapsed({ ...collapsed, [node.path]: open })}
        >
          <span className="dshws-group-caret">
            <IconChevronDown size={14} />
          </span>
          <IconFolder open={open} size={15} />
          <span className="dshws-group-name">{node.name}</span>
          <span className="dshws-group-count">{node.total}</span>
          <span className="dshws-group-actions" onClick={(e) => e.stopPropagation()}>
            <IconButton title={t('list.newHost')} onClick={() => props.onAddHostInGroup(node.path)}>
              <IconPlus size={14} />
            </IconButton>
            <IconButton title={t('group.edit')} onClick={() => props.onEditGroup(node.path)}>
              <IconPencil size={14} />
            </IconButton>
            {isRecord ? (
              <IconButton tone="danger" title={t('group.delete')} onClick={() => props.onDeleteGroup(node.path)}>
                <IconTrash size={14} />
              </IconButton>
            ) : null}
          </span>
        </div>
        {open ? <div className="dshws-group-body">{body}</div> : null}
      </div>
    )
  }

  if (props.hosts.length === 0 && props.groups.length === 0) {
    return (
      <div className="dshws-empty">
        <IconServer size={28} />
        <div>{t('list.empty')}</div>
      </div>
    )
  }
  const rendered = renderNode(tree, 0)
  if (props.query !== '' && props.hosts.filter((h) => matches(h, props.query)).length === 0) {
    return <div className="dshws-empty">{t('list.noMatch')}</div>
  }
  return (
    <div className="dshws-hostlist" data-dragging={dragging !== undefined} {...dropProps('')} onDragLeave={(e) => {
      // 拖出整个列表时清掉高亮。
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropPath(null)
    }}>
      {dragging !== undefined ? (
        <div className="dshws-drop-root" data-drop={dropPath === ''} data-disabled={dragging.groupPath === ''}>
          {dragging.groupPath === '' ? t('host.dropHintRoot') : t('host.dropToRoot')}
        </div>
      ) : null}
      {rendered}
    </div>
  )
}

function AuthChip(props: { t: Translate; host: HostView }) {
  const { t, host } = props
  if (host.auth === null) return <span className="dshws-chip">{t('host.inherit')}</span>
  const label =
    host.auth.kind === 'password'
      ? t('host.password')
      : host.auth.kind === 'agent'
        ? t('host.agent')
        : t('host.key')
  return <span className="dshws-chip">{label}</span>
}

function HostMenu(props: HostListProps & { host: HostView }) {
  const { t, host } = props
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      align="end"
      portal
      anchor={
        <button type="button" className="dshws-ibtn" aria-label={t('common.more')} title={t('common.more')} onClick={() => setOpen(!open)}>
          <IconMore size={15} />
        </button>
      }
      items={[
        { id: 'disconnect', label: t('host.disconnect') },
        { id: 'forgetKey', label: t('host.forgetKey') },
        { type: 'separator' },
        { id: 'delete', label: t('host.delete'), danger: true }
      ]}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'disconnect') props.onDisconnect(host)
        if (id === 'forgetKey') props.onForgetKey(host)
        if (id === 'delete') props.onDelete(host)
      }}
    />
  )
}
