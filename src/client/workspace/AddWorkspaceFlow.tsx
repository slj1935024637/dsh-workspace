/*
 * @Description: 「添加工作区」弹窗 —— 接管 DSH 的 directoryFlow 插槽（左侧位置栏：本机 / 远程主机；右侧目录浏览）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/workspace/AddWorkspaceFlow.tsx
 *
 * 插槽协议（dsh-cordis-client-runner）：宿主传 open / busy / onPicked / onCancel / onError，
 * open 由 false 变 true 表示一次新的请求，每次请求只能上报一个结果。
 * onPicked(path) 之后宿主自己 ctx.workspaces.create({ path })（同路径幂等）并打开会话。
 *
 * 我们在 onPicked 之前先自己 create + rename：这样能按用户填的名称命名（官方流程只能取目录名）。
 *
 * 为什么自己做本机浏览而不是沿用 DSH 的：DSH 自带的浏览选择器把家目录折叠成「主目录」、不列盘符，
 * 在家目录里无法走到上一级或别的磁盘。这里用同一个宿主接口 listDirectory（它本身可列任意绝对路径），
 * 再用「逐个盘符试列」补出 Windows 的盘符列表。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { RemoteCallError } from '../api.js'
import { ERROR_CODES } from '../../wire/contract.js'
import type { HostView } from '../../types.js'
import { IconChevron, IconDesktop, IconDoc, IconDownload, IconDrive, IconFolder, IconFolderPlus, IconHome, IconLock, IconServer } from '../sidebar/ui.js'
import {
  DRIVES,
  FolderBrowser,
  isWindowsPath,
  lastSegment,
  localCrumbs,
  localParent,
  remoteCrumbs,
  remoteParent,
  type FolderBackend
} from './FolderBrowser.js'

interface WorkspacesController {
  create(input: { path: string }): Promise<{ workspaceId: string; title: string }>
  rename(workspaceId: string, title: string): Promise<unknown>
}

/** 宿主 DirectoryListing（dsh-host-directory-picker）：crumbs 为根到当前目录的祖先链。 */
interface HostListing {
  path: string
  home?: string
  crumbs?: Array<{ name: string; path: string }>
  entries: Array<{ name: string; path: string; hidden?: boolean }>
  truncated?: boolean
}

interface UiWorkspace {
  listDirectory(path: string | undefined, signal?: AbortSignal): Promise<HostListing>
  createDirectory(path: string, name: string): Promise<unknown>
}

declare global {
  interface Window {
    /** DSH Desktop 注入的原生选择文件夹对话框（桌面版才有）。 */
    __DSH_DESKTOP_PICK_DIRECTORY__?: () => Promise<string | null>
  }
}

export interface AddWorkspaceFlowProps {
  // 宿主 ownerProps
  open: boolean
  busy?: boolean
  onPicked(path: string): void
  onCancel(): void
  onError(message: string): void
  // 本插件注入
  t: Translate
  api: WorkspaceApi
  workspaces: () => WorkspacesController | undefined
  uiWorkspace: () => UiWorkspace | undefined
  /** 弹窗出现后调用（移动端用来收起左侧抽屉）。 */
  onShown?(): void
}

type Source = { kind: 'local' } | { kind: 'remote'; hostId: string }

/** 左侧「位置」里的一项本机快捷目录。 */
interface Place {
  id: string
  label: string
  path: string
  icon: ReactNode
}

const SOURCE_KEY = 'dshws.add.tab'
const HOST_KEY = 'dshws.add.host'
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
/** 单个盘符的试列超时：光驱 / 断开的网络盘可能很慢，不能拖住整个列表。 */
const DRIVE_PROBE_MS = 3000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 逐个盘符试列根目录，能列出的就是存在的盘。 */
async function probeDrives(ui: UiWorkspace): Promise<string[]> {
  const results = await Promise.all(
    [...DRIVE_LETTERS].map(async (letter) => {
      const root = `${letter}:\\`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DRIVE_PROBE_MS)
      try {
        await ui.listDirectory(root, controller.signal)
        return root
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    })
  )
  return results.filter((r): r is string => r !== null)
}

function hostSubtitle(h: HostView): string {
  return `${h.username !== undefined && h.username !== '' ? `${h.username}@` : ''}${h.hostname}${h.port !== 22 ? `:${h.port}` : ''}`
}

/** 远程主机按分组组成的树（与「远程工作区」页面的主机列表同一种结构）。 */
interface HostNode {
  path: string
  name: string
  hosts: HostView[]
  children: HostNode[]
  total: number
}

export function buildHostTree(hosts: HostView[]): HostNode {
  const root: HostNode = { path: '', name: '', hosts: [], children: [], total: 0 }
  const index = new Map<string, HostNode>([['', root]])
  const ensure = (p: string): HostNode => {
    const found = index.get(p)
    if (found !== undefined) return found
    const slash = p.lastIndexOf('/')
    const parent = ensure(slash === -1 ? '' : p.slice(0, slash))
    const node: HostNode = { path: p, name: slash === -1 ? p : p.slice(slash + 1), hosts: [], children: [], total: 0 }
    parent.children.push(node)
    index.set(p, node)
    return node
  }
  for (const h of hosts) ensure(h.groupPath).hosts.push(h)
  const finalize = (n: HostNode): number => {
    n.hosts.sort((a, b) => a.label.localeCompare(b.label))
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.total = n.hosts.length + n.children.reduce((s, c) => s + finalize(c), 0)
    return n.total
  }
  finalize(root)
  return root
}

/** 左侧栏折叠状态（此电脑 / 远程主机 / 各分组），记在浏览器里。 */
const FOLD_KEY = 'dshws.add.folded'
function readFolded(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

type RemotePhase = { hostId: string; phase: 'connecting' | 'ready' | 'error' }

export function AddWorkspaceFlow(props: AddWorkspaceFlowProps) {
  const { t, api } = props
  const [visible, setVisible] = useState(false)
  const [source, setSource] = useState<Source>({ kind: 'local' })
  /** 浏览器的起点与重建序号：点左侧位置时换起点并重建浏览器。 */
  const [start, setStart] = useState<{ path: string | undefined; seq: number }>({ path: undefined, seq: 0 })
  const [path, setPath] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [hosts, setHosts] = useState<HostView[]>([])
  const [locked, setLocked] = useState(false)
  const [password, setPassword] = useState('')
  const [places, setPlaces] = useState<Place[]>([])
  const [drives, setDrives] = useState<string[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [mkdirRequest, setMkdirRequest] = useState(0)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 远程主机的连接状态：选中后首次列目录前为 connecting（SSH 握手可能要几秒），期间界面照常可操作。 */
  const [remotePhase, setRemotePhase] = useState<RemotePhase | null>(null)
  const [folded, setFolded] = useState<Record<string, boolean>>(readFolded)
  const toggleFold = (key: string): void => {
    setFolded((cur) => {
      const next = { ...cur, [key]: cur[key] !== true }
      localStorage.setItem(FOLD_KEY, JSON.stringify(next))
      return next
    })
  }
  const reported = useRef(false)
  const drivesPromise = useRef<Promise<string[]> | null>(null)
  const latest = useRef(props)
  latest.current = props

  const ui = props.uiWorkspace()
  const localAvailable = ui !== undefined && typeof ui.listDirectory === 'function'

  // open 上升沿：开始一次新请求。下降沿（宿主撤回）：静默关闭，不再上报。
  useEffect(() => {
    if (!props.open) {
      setVisible(false)
      return
    }
    reported.current = false
    setVisible(true)
    // 收抽屉失败不能影响弹窗本身。
    try {
      latest.current.onShown?.()
    } catch (err) {
      console.warn('[dsh-workspace] 收起抽屉失败', err)
    }
    setError(null)
    setPath(undefined)
    setTitle('')
    setTitleTouched(false)
    setMkdirRequest(0)
    const remembered = localStorage.getItem(SOURCE_KEY) === 'remote' ? localStorage.getItem(HOST_KEY) : null
    setSource(remembered !== null && remembered !== '' ? { kind: 'remote', hostId: remembered } : { kind: 'local' })
    setRemotePhase(remembered !== null && remembered !== '' ? { hostId: remembered, phase: 'connecting' } : null)
    setStart((s) => ({ path: undefined, seq: s.seq + 1 }))
    void api
      .call('state', {})
      .then((s) => {
        setHosts(s.hosts)
        setLocked(s.initialized && !s.unlocked)
        // 记住的主机已被删掉：退回本机。
        if (remembered !== null && !s.hosts.some((h) => h.id === remembered)) setSource({ kind: 'local' })
      })
      .catch(() => undefined)

    // 本机快捷位置：家目录 + 其中常见的桌面 / 文档 / 下载；Windows 再补盘符。
    const uiNow = latest.current.uiWorkspace()
    if (uiNow === undefined || typeof uiNow.listDirectory !== 'function') return
    void uiNow
      .listDirectory(undefined)
      .then((home) => {
        const find = (name: string) => home.entries.find((e) => e.name.toLowerCase() === name.toLowerCase())
        const next: Place[] = [{ id: 'home', label: t('add.placeHome'), path: home.path, icon: <IconHome size={15} /> }]
        const extra: Array<[string, string, ReactNode]> = [
          ['Desktop', t('add.placeDesktop'), <IconDesktop size={15} />],
          ['Documents', t('add.placeDocuments'), <IconDoc size={15} />],
          ['Downloads', t('add.placeDownloads'), <IconDownload size={15} />]
        ]
        for (const [name, label, icon] of extra) {
          const hit = find(name)
          if (hit !== undefined) next.push({ id: name, label, path: hit.path, icon })
        }
        setPlaces(next)
        if (isWindowsPath(home.path)) {
          drivesPromise.current = probeDrives(uiNow)
          void drivesPromise.current.then(setDrives)
        }
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, api])

  const report = (kind: 'picked' | 'cancel', value?: string): void => {
    if (reported.current) return
    reported.current = true
    setVisible(false)
    if (kind === 'picked' && value !== undefined) latest.current.onPicked(value)
    else latest.current.onCancel()
  }

  /** 切换位置：换数据源 / 起点并重建浏览器。 */
  const go = (next: Source, startPath?: string): void => {
    setSource(next)
    localStorage.setItem(SOURCE_KEY, next.kind)
    if (next.kind === 'remote') localStorage.setItem(HOST_KEY, next.hostId)
    // 同一台主机已连上时再点它只是回到起始目录，不再显示「连接中」。
    setRemotePhase((cur) =>
      next.kind !== 'remote' ? null : cur !== null && cur.hostId === next.hostId && cur.phase === 'ready' ? cur : { hostId: next.hostId, phase: 'connecting' }
    )
    setStart((s) => ({ path: startPath, seq: s.seq + 1 }))
    setPath(undefined)
    if (!titleTouched) setTitle('')
    setError(null)
  }

  // 选中的目录变化时，未手动改过名称就跟随目录名。首次列出远程目录即视为已连上。
  const choosePath = (p: string | undefined): void => {
    setPath(p)
    if (!titleTouched) setTitle(p !== undefined ? lastSegment(p) || p : '')
    if (p !== undefined) setRemotePhase((cur) => (cur !== null && cur.phase !== 'ready' ? { ...cur, phase: 'ready' } : cur))
  }

  const localBackend = useMemo<FolderBackend | undefined>(() => {
    if (!localAvailable) return undefined
    const uiNow = ui
    return {
      list: async (p, signal) => {
        if (p === DRIVES) {
          const list = await (drivesPromise.current ?? probeDrives(uiNow))
          return {
            path: DRIVES,
            parent: undefined,
            crumbs: [{ name: t('add.thisPc'), path: DRIVES }],
            entries: list.map((d) => ({ name: t('add.driveLabel', { drive: d.slice(0, 2) }), path: d, hidden: false, kind: 'drive' as const })),
            truncated: false,
            virtual: true
          }
        }
        const r = await uiNow.listDirectory(p, signal)
        const win = isWindowsPath(r.path)
        const base = r.crumbs !== undefined && r.crumbs.length > 0 ? r.crumbs.map((c) => ({ name: c.name, path: c.path })) : localCrumbs(r.path)
        return {
          path: r.path,
          // 盘符根的上一级是「此电脑」（盘符列表）。
          parent: localParent(r.path) ?? (win ? DRIVES : undefined),
          crumbs: win ? [{ name: t('add.thisPc'), path: DRIVES }, ...base] : base,
          entries: r.entries.map((e) => ({ name: e.name, path: e.path, hidden: e.hidden === true || e.name.startsWith('.') })),
          truncated: r.truncated === true
        }
      },
      mkdir: async (parent, name) => {
        const created = await uiNow.createDirectory(parent, name)
        if (typeof created === 'string' && created !== '') return created
        return `${parent.replace(/[\\/]+$/, '')}${parent.includes('\\') ? '\\' : '/'}${name}`
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localAvailable])

  const remoteHostId = source.kind === 'remote' ? source.hostId : ''
  const remoteBackend = useMemo<FolderBackend | undefined>(() => {
    if (remoteHostId === '') return undefined
    const hostId = remoteHostId
    return {
      list: async (p) => {
        const target = p ?? (await api.call('sftpHome', { hostId })).path
        const r = await api.call('sftpList', { hostId, path: target })
        return {
          path: r.path,
          parent: remoteParent(r.path),
          crumbs: remoteCrumbs(r.path),
          entries: r.entries
            .filter((e) => e.type === 'dir' || e.linkIsDir === true)
            .map((e) => ({ name: e.name, path: e.path, hidden: e.hidden })),
          truncated: r.truncated
        }
      },
      mkdir: async (parent, name) => (await api.call('sftpMkdir', { hostId, parent, name })).path
    }
  }, [api, remoteHostId])

  const onRemoteError = (err: unknown): boolean => {
    // 还没连上就失败了：标记为连接失败（左侧主机行显示错误点，右侧可重试）。
    setRemotePhase((cur) => (cur !== null && cur.phase === 'connecting' ? { ...cur, phase: 'error' } : cur))
    if (err instanceof RemoteCallError && err.code === ERROR_CODES.vaultLocked) {
      setLocked(true)
      return true
    }
    return false
  }

  const unlock = async (): Promise<void> => {
    setError(null)
    try {
      const r = await api.call('unlock', { password })
      if (!r.ok) {
        setError(t('vault.wrong'))
        return
      }
      setLocked(false)
      setPassword('')
      setStart((s) => ({ ...s, seq: s.seq + 1 }))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const pickNative = async (): Promise<void> => {
    const picker = window.__DSH_DESKTOP_PICK_DIRECTORY__
    if (picker === undefined) return
    try {
      const chosen = await picker()
      if (chosen !== null && chosen !== '') go({ kind: 'local' }, chosen)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  /**
   * 创建：远程先让宿主建占位目录；然后自己 create + rename（按用户填的名称）；最后交给宿主。
   * 改名失败（名称已被别的工作区占用）不阻断创建：保留目录名作为标题并提示。
   */
  const submit = async (): Promise<void> => {
    if (path === undefined || working) return
    const wanted = title.trim()
    setWorking(true)
    setError(null)
    try {
      let localPath = path
      if (source.kind === 'remote') {
        localPath = (await api.call('createRemoteWorkspace', { hostId: source.hostId, remotePath: path, title: wanted || lastSegment(path) || 'root' })).localPath
      }
      const controller = props.workspaces()
      if (controller !== undefined && wanted !== '') {
        const ws = await controller.create({ path: localPath })
        if (ws.title !== wanted) {
          await controller.rename(ws.workspaceId, wanted).catch((err: unknown) => {
            console.warn('[dsh-workspace] 工作区改名失败，保留默认名称：', err)
          })
        }
      }
      report('picked', localPath)
    } catch (err) {
      if (!onRemoteError(err)) setError(messageOf(err))
    } finally {
      setWorking(false)
    }
  }

  if (!visible) return null
  const busy = working || props.busy === true
  const selectedHost = source.kind === 'remote' ? hosts.find((h) => h.id === source.hostId) : undefined
  const remoteLocked = source.kind === 'remote' && locked
  const backend = source.kind === 'local' ? localBackend : remoteBackend
  const hasNative = window.__DSH_DESKTOP_PICK_DIRECTORY__ !== undefined

  const renderBrowser = (): ReactNode => {
    if (source.kind === 'local') {
      if (localBackend === undefined) {
        return (
          <div className="dshws-pk-empty">
            <span>{t('add.noLocalPicker')}</span>
            {hasNative ? (
              <Button variant="outline" size="sm" onClick={() => void pickNative()}>
                {t('add.pickNative')}
              </Button>
            ) : null}
          </div>
        )
      }
      return (
        <FolderBrowser
          key={`local-${start.seq}`}
          t={t}
          backend={localBackend}
          {...(start.path !== undefined ? { initialPath: start.path } : {})}
          showHidden={showHidden}
          mkdirRequest={mkdirRequest}
          onPathChange={choosePath}
        />
      )
    }
    if (remoteLocked) {
      return (
        <div className="dshws-pk-empty">
          <IconLock size={22} />
          <span>{t('add.lockedHint')}</span>
          <div className="dshws-add-unlock">
            <input
              type="password"
              className="dshws-input"
              value={password}
              autoFocus
              placeholder={t('vault.password')}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unlock()
              }}
            />
            <Button variant="primary" size="sm" onClick={() => void unlock()} disabled={password === ''}>
              {t('vault.unlock')}
            </Button>
          </div>
        </div>
      )
    }
    if (remoteBackend === undefined || selectedHost === undefined) {
      return <div className="dshws-pk-empty">{t('add.pickHost')}</div>
    }
    return (
      <FolderBrowser
        key={`${source.hostId}-${start.seq}`}
        t={t}
        backend={remoteBackend}
        {...(start.path !== undefined ? { initialPath: start.path } : {})}
        showHidden={showHidden}
        mkdirRequest={mkdirRequest}
        onPathChange={choosePath}
        onError={onRemoteError}
        loadingLabel={t('add.connecting', { host: selectedHost.label })}
        retryable
      />
    )
  }

  /** 远程主机树：分组可折叠；主机行显示连接中 / 失败 / 锁定。 */
  const renderHostNode = (node: HostNode, depth: number): ReactNode => {
    const hostRows = node.hosts.map((h) => {
      const active = source.kind === 'remote' && source.hostId === h.id
      const phase = remotePhase !== null && remotePhase.hostId === h.id ? remotePhase.phase : undefined
      return (
        <button
          key={h.id}
          type="button"
          className="dshws-pk-place dshws-pk-host"
          data-active={active}
          data-phase={phase}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={`${h.groupPath !== '' ? `${h.groupPath} / ` : ''}${h.label} — ${hostSubtitle(h)}`}
          onClick={() => go({ kind: 'remote', hostId: h.id })}
        >
          {phase === 'connecting' ? <span className="dshws-spinner" aria-label={t('add.connectingShort')} /> : <IconServer size={15} />}
          <span className="dshws-pk-host-text">
            <span className="dshws-pk-place-name">{h.label}</span>
            <span className="dshws-pk-host-sub">{phase === 'connecting' ? t('add.connectingShort') : phase === 'error' ? t('add.connectFailed') : hostSubtitle(h)}</span>
          </span>
          {locked ? <IconLock size={12} /> : null}
        </button>
      )
    })
    const groups = node.children.map((g) => {
      const key = `group:${g.path}`
      const open = folded[key] !== true
      return (
        <div key={g.path}>
          <button type="button" className="dshws-pk-place dshws-pk-group" style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={open} title={g.path} onClick={() => toggleFold(key)}>
            <IconChevron size={12} open={open} />
            <IconFolder size={14} open={open} />
            <span className="dshws-pk-place-name">{g.name}</span>
            <span className="dshws-pk-count">{g.total}</span>
          </button>
          {open ? renderHostNode(g, depth + 1) : null}
        </div>
      )
    })
    return (
      <>
        {hostRows}
        {groups}
      </>
    )
  }
  const hostTree = buildHostTree(hosts)
  const drivesOpen = folded.drives !== true
  const remoteOpen = folded.remote !== true

  const localActive = (p: string): boolean => source.kind === 'local' && path !== undefined && path.toLowerCase() === p.toLowerCase()

  return (
    <Modal
      open
      onClose={() => report('cancel')}
      title={t('add.title')}
      closeLabel={t('common.close')}
      className="dshws-picker"
      footer={
        <div className="dshws-pk-footer">
          <div className="dshws-pk-footer-left">
            <Button
              size="sm"
              variant="outline"
              icon={<IconFolderPlus size={15} />}
              disabled={backend === undefined || backend.mkdir === undefined || path === undefined || remoteLocked}
              onClick={() => setMkdirRequest((n) => n + 1)}
            >
              {t('files.newFolder')}
            </Button>
            {source.kind === 'local' && hasNative && localBackend !== undefined ? (
              <Button size="sm" variant="outline" onClick={() => void pickNative()} disabled={busy}>
                {t('add.pickNative')}
              </Button>
            ) : null}
            <label className="dshws-check">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              {t('add.showHidden')}
            </label>
          </div>
          <div className="dshws-dialog-actions">
            <Button variant="outline" onClick={() => report('cancel')} disabled={busy}>
              {t('form.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || path === undefined || remoteLocked}>
              {busy ? t('add.creating') : t('add.create')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="dshws-pk">
        <nav className="dshws-pk-rail" aria-label={t('add.places')}>
          <div className="dshws-pk-rail-title">{t('add.local')}</div>
          {places.map((p) => (
            <button key={p.id} type="button" className="dshws-pk-place" data-active={localActive(p.path)} title={p.path} onClick={() => go({ kind: 'local' }, p.path)}>
              {p.icon}
              <span className="dshws-pk-place-name">{p.label}</span>
            </button>
          ))}
          {drives.length > 0 ? (
            <div className="dshws-pk-place dshws-pk-folder" data-active={source.kind === 'local' && path === undefined && start.path === DRIVES}>
              <button
                type="button"
                className="dshws-pk-fold"
                aria-label={drivesOpen ? t('add.collapse') : t('add.expand')}
                aria-expanded={drivesOpen}
                onClick={() => toggleFold('drives')}
              >
                <IconChevron size={12} open={drivesOpen} />
              </button>
              <button type="button" className="dshws-pk-folder-main" onClick={() => go({ kind: 'local' }, DRIVES)}>
                <IconDrive size={15} />
                <span className="dshws-pk-place-name">{t('add.thisPc')}</span>
              </button>
            </div>
          ) : null}
          {(drivesOpen ? drives : []).map((d) => (
            <button key={d} type="button" className="dshws-pk-place dshws-pk-place-sub" data-active={localActive(d)} title={d} onClick={() => go({ kind: 'local' }, d)}>
              <IconDrive size={14} />
              <span className="dshws-pk-place-name">{t('add.driveLabel', { drive: d.slice(0, 2) })}</span>
            </button>
          ))}
          {places.length === 0 && localAvailable ? (
            <button type="button" className="dshws-pk-place" data-active={source.kind === 'local'} onClick={() => go({ kind: 'local' })}>
              <IconHome size={15} />
              <span className="dshws-pk-place-name">{t('add.placeHome')}</span>
            </button>
          ) : null}

          <button type="button" className="dshws-pk-rail-title dshws-pk-rail-toggle" aria-expanded={remoteOpen} onClick={() => toggleFold('remote')}>
            <IconChevron size={11} open={remoteOpen} />
            <span>{t('add.remoteHosts')}</span>
            {hosts.length > 0 ? <span className="dshws-pk-count">{hosts.length}</span> : null}
          </button>
          {remoteOpen && hosts.length === 0 ? <div className="dshws-pk-rail-note">{t('add.noHosts')}</div> : null}
          {remoteOpen ? renderHostNode(hostTree, 0) : null}
        </nav>

        <div className="dshws-pk-main">
          <div className="dshws-pk-source">
            {source.kind === 'local' ? t('add.sourceLocal') : selectedHost !== undefined ? t('add.sourceRemote', { host: selectedHost.label, addr: hostSubtitle(selectedHost) }) : t('add.remote')}
          </div>
          {renderBrowser()}
        </div>
      </div>

      <div className="dshws-pk-bottom">
        <label className="dshws-add-row">
          <span>{t('add.name')}</span>
          <input
            className="dshws-input"
            value={title}
            maxLength={120}
            placeholder={t('add.namePlaceholder')}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleTouched(true)
            }}
          />
        </label>
        <div className="dshws-add-selected dshws-mono" title={path}>
          {path === undefined ? t('add.noneSelected') : `${selectedHost !== undefined ? `${selectedHost.label}:` : ''}${path}`}
        </div>
        {error !== null ? <div className="dshws-form-error">{error}</div> : null}
      </div>
    </Modal>
  )
}
