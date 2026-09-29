/*
 * @Description: 终端标签页区域 —— 多终端切换、改名、后台保留、结束后重开、上次终端恢复
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/TerminalsPane.tsx
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Menu, StateDot, type MenuEntry, type StateDotProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostView } from '../../types.js'
import type { RecentTerminal, TerminalView as TerminalInfo } from '../../wire/dto.js'
import type { Translate } from '../context.js'
import { TerminalView, type LinkState } from '../terminal/TerminalView.js'
import { messageOf, type WorkspaceModel } from './useWorkspace.js'
import { useDialogs } from './dialogs.js'
import { IconClose, IconMore } from '../sidebar/ui.js'

/**
 * 「新建终端」按钮：点开是按分组排列的主机菜单，选中即连接。
 * 打开期间按钮显示进度 —— 跳板链握手可能要一两秒，不给反馈用户会重复点击。
 */
function NewTerminalButton(props: {
  t: Translate
  hosts: HostView[]
  onOpen: (hostId: string) => Promise<void>
  onError: (message: string) => void
  variant: 'primary' | 'tab'
}) {
  const { t } = props
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const items = useMemo<MenuEntry[]>(() => {
    if (props.hosts.length === 0) return [{ id: '', label: t('term.noHosts'), disabled: true }]
    const byGroup = new Map<string, HostView[]>()
    for (const host of props.hosts) {
      const list = byGroup.get(host.groupPath) ?? []
      list.push(host)
      byGroup.set(host.groupPath, list)
    }
    const entries: MenuEntry[] = []
    for (const group of [...byGroup.keys()].sort()) {
      if (byGroup.size > 1) entries.push({ type: 'label', text: group === '' ? t('term.ungrouped') : group })
      for (const host of (byGroup.get(group) ?? []).sort((a, b) => a.label.localeCompare(b.label))) {
        entries.push({ id: host.id, label: `${host.label}  ·  ${host.username !== undefined ? `${host.username}@` : ''}${host.hostname}` })
      }
    }
    return entries
  }, [props.hosts, t])

  const pick = async (hostId: string): Promise<void> => {
    setOpen(false)
    if (hostId === '') return
    setBusy(true)
    try {
      await props.onOpen(hostId)
    } catch (error) {
      props.onError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const label = busy ? t('host.opening') : t('term.new')
  return (
    <Menu
      open={open}
      align="start"
      portal
      anchor={
        props.variant === 'primary' ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setOpen(!open)}>
            {label}
          </Button>
        ) : (
          <button
            type="button"
            className="dshws-tab dshws-tab-new"
            disabled={busy}
            title={t('term.new')}
            onClick={() => setOpen(!open)}
          >
            {busy ? label : '＋'}
          </button>
        )
      }
      items={items}
      onClose={() => setOpen(false)}
      onSelect={(id) => void pick(id)}
    />
  )
}

export interface TerminalsPaneProps {
  t: Translate
  model: WorkspaceModel
  terminals: TerminalInfo[]
  recent: RecentTerminal[]
  hosts: HostView[]
  activeId: string | null
  scrollback: number
  onActivate: (id: string | null) => void
  onOpen: (hostId: string, options?: { cwd?: string; title?: string }) => Promise<void>
  onError: (message: string) => void
}

function dotOf(status: TerminalInfo['status'], link: LinkState | undefined): StateDotProps['state'] {
  if (status === 'exited' || link === 'gone') return 'idle'
  if (status === 'opening' || link === 'connecting' || link === 'reconnecting') return 'ongoing'
  return 'done'
}

export function TerminalsPane(props: TerminalsPaneProps) {
  const { t } = props
  const [links, setLinks] = useState<Record<string, LinkState>>({})
  /** WS 推来的最新状态比轮询快，优先用它覆盖轮询快照。 */
  const [live, setLive] = useState<Record<string, TerminalInfo>>({})
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const dialogs = useDialogs()

  const ordered = useMemo(
    () =>
      props.terminals
        .map((term) => live[term.id] ?? term)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [props.terminals, live]
  )

  // 当前激活的终端消失（被关闭 / 回收）时，自动切到最后一个。
  useEffect(() => {
    if (props.activeId !== null && ordered.some((x) => x.id === props.activeId)) return
    const last = ordered[ordered.length - 1]
    props.onActivate(last === undefined ? null : last.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, props.activeId])

  const hostLabel = (hostId: string): string => props.hosts.find((h) => h.id === hostId)?.label ?? hostId

  const close = async (id: string): Promise<void> => {
    try {
      await props.model.call('closeTerminal', { id })
    } catch (error) {
      props.onError(messageOf(error))
    }
  }

  const rename = async (term: TerminalInfo): Promise<void> => {
    const next = await dialogs.prompt({ title: t('term.rename'), label: t('term.renamePrompt'), defaultValue: term.title })
    if (next === null || next === term.title) return
    try {
      await props.model.call('renameTerminal', { id: term.id, title: next })
    } catch (error) {
      props.onError(messageOf(error))
    }
  }

  const toggleKeep = async (term: TerminalInfo): Promise<void> => {
    try {
      const updated = await props.model.call('setTerminalKeepAlive', { id: term.id, keepAlive: !term.keepAlive })
      setLive((prev) => ({ ...prev, [term.id]: updated }))
    } catch (error) {
      props.onError(messageOf(error))
    }
  }

  /** 结束的终端：在同主机开一个新的，并关掉旧的。 */
  const reopen = async (term: TerminalInfo): Promise<void> => {
    try {
      await props.onOpen(term.hostId, { title: term.title })
      await props.model.call('closeTerminal', { id: term.id })
    } catch (error) {
      props.onError(messageOf(error))
    }
  }

  const reopenRecent = async (): Promise<void> => {
    for (const entry of props.recent) {
      if (!props.hosts.some((h) => h.id === entry.hostId)) continue
      try {
        await props.onOpen(entry.hostId, {
          title: entry.title,
          ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {})
        })
      } catch (error) {
        // 某一台失败（如已不可达）不应阻止其余终端重开。
        props.onError(messageOf(error))
      }
    }
    await props.model.call('clearRecentTerminals', {}).catch(() => undefined)
  }

  const recentUsable = props.recent.filter((r) => props.hosts.some((h) => h.id === r.hostId))

  return (
    <div className="dshws-terms">
      {recentUsable.length > 0 ? (
        <div className="dshws-banner">
          <div className="dshws-banner-text">
            <div className="dshws-banner-title">{t('term.recentTitle')}</div>
            <div className="dshws-banner-hint">{recentUsable.map((r) => r.title).join('、')}</div>
          </div>
          <div className="dshws-banner-form">
            <Button size="sm" variant="primary" onClick={() => void reopenRecent()}>
              {t('term.reopenAll')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void props.model.call('clearRecentTerminals', {})}>
              {t('term.dismiss')}
            </Button>
          </div>
        </div>
      ) : null}

      {ordered.length === 0 ? (
        <div className="dshws-empty">
          <div>{t('term.empty')}</div>
          <div style={{ marginTop: 12 }}>
            <NewTerminalButton t={t} hosts={props.hosts} onOpen={props.onOpen} onError={props.onError} variant="primary" />
          </div>
        </div>
      ) : (
        <>
          <div className="dshws-tabs" role="tablist">
            {ordered.map((term) => (
              <div
                key={term.id}
                role="tab"
                aria-selected={term.id === props.activeId}
                className="dshws-tab"
                data-active={term.id === props.activeId}
                data-exited={term.status === 'exited'}
                onClick={() => props.onActivate(term.id)}
                onDoubleClick={() => void rename(term)}
                onAuxClick={(e) => {
                  // 中键关闭，与浏览器标签页习惯一致。
                  if (e.button === 1) void close(term.id)
                }}
                title={`${hostLabel(term.hostId)} · ${term.title}`}
              >
                <StateDot state={dotOf(term.status, links[term.id])} size={8} />
                <span className="dshws-tab-title">{term.title}</span>
                {term.keepAlive ? <span className="dshws-tab-pin" title={t('term.keepAlive')}>●</span> : null}
                <Menu
                  open={menuFor === term.id}
                  align="end"
                  portal
                  anchor={
                    <button
                      type="button"
                      className="dshws-tab-btn"
                      aria-label={t('common.more')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuFor(menuFor === term.id ? null : term.id)
                      }}
                    >
                      <IconMore size={14} />
                    </button>
                  }
                  items={[
                    { id: 'rename', label: t('term.rename') },
                    { id: 'keep', label: term.keepAlive ? t('term.unkeep') : t('term.keep') },
                    { type: 'separator' },
                    { id: 'close', label: t('term.close'), danger: true }
                  ]}
                  onClose={() => setMenuFor(null)}
                  onSelect={(id) => {
                    setMenuFor(null)
                    if (id === 'rename') void rename(term)
                    if (id === 'keep') void toggleKeep(term)
                    if (id === 'close') void close(term.id)
                  }}
                />
                <button
                  type="button"
                  className="dshws-tab-btn"
                  aria-label={t('term.close')}
                  title={t('term.close')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void close(term.id)
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
            <NewTerminalButton t={t} hosts={props.hosts} onOpen={props.onOpen} onError={props.onError} variant="tab" />
          </div>

          <div className="dshws-term-stack">
            {ordered.map((term) => (
              // 所有终端保持挂载、只切换可见性：切标签不断开连接，也就不会反复回放。
              <div
                key={term.id}
                className="dshws-term-slot"
                style={{ display: term.id === props.activeId ? 'flex' : 'none' }}
              >
                {term.status === 'exited' ? (
                  <div className="dshws-term-banner" data-tone="info">
                    <span>{t('term.exited', { reason: term.reason ?? '' })}</span>
                    <Button size="sm" variant="outline" onClick={() => void reopen(term)}>
                      {t('term.reopen')}
                    </Button>
                  </div>
                ) : null}
                <TerminalView
                  t={t}
                  terminalId={term.id}
                  active={term.id === props.activeId}
                  scrollback={props.scrollback}
                  onStatus={(info) => setLive((prev) => ({ ...prev, [info.id]: info }))}
                  onLinkState={(state) => setLinks((prev) => ({ ...prev, [term.id]: state }))}
                  exited={term.status === 'exited'}
                  onRestart={() => void reopen(term)}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
