/*
 * @Description: 右侧栏「SSH 终端」标签 —— 连到当前远程工作区的主机，初始目录为工作区根
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/SshTab.tsx
 */
import { useEffect, useState } from 'react'
import { TerminalView } from '../terminal/TerminalView.js'
import type { SidebarBodyProps, SidebarTabInfo } from './RemoteFileTab.js'

/**
 * 右侧栏标签 id → 宿主终端 id。标签隐藏 / 切换时组件会卸载重挂，
 * 终端本身留在宿主（输出整段回放），所以按标签 id 复用同一个终端，而不是每次重开。
 */
const terminalsByTab = new Map<string, Promise<string>>()

export function SshTab(props: SidebarBodyProps) {
  const { t, api, index, sessionId } = props
  // SSH 标签只注册在右侧栏，一定有标签信息。
  const info = (props.useTabInfo as () => SidebarTabInfo)()
  const [, setVersion] = useState(0)
  useEffect(() => index.subscribe(() => setVersion((v) => v + 1)), [index])
  const workspace = index.bySession(sessionId)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (workspace === undefined) return
    const key = `${info.tab.id}#${nonce}`
    let pending = terminalsByTab.get(key)
    if (pending === undefined) {
      pending = api
        .call('openTerminal', { hostId: workspace.hostId, cols: 100, rows: 30, cwd: workspace.remotePath, title: workspace.title })
        .then((view) => view.id)
      terminalsByTab.set(key, pending)
      pending.catch(() => terminalsByTab.delete(key))
    }
    let alive = true
    pending.then(
      (id) => alive && setTerminalId(id),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      alive = false
    }
  }, [api, info.tab.id, nonce, workspace])

  if (workspace === undefined) return <div className="dshws-side-note">{t('side.notRemote')}</div>
  if (error !== null) {
    return (
      <div className="dshws-side-note" data-tone="error">
        {error}
        <button type="button" className="dshws-link-btn" onClick={() => { setError(null); setNonce((n) => n + 1) }}>
          {t('term.menuReconnect')}
        </button>
      </div>
    )
  }
  if (terminalId === null) return <div className="dshws-side-note">{t('term.connecting')}</div>
  return (
    <div className="dshws-side dshws-side-term">
      <TerminalView
        key={terminalId}
        t={t}
        terminalId={terminalId}
        active={info.tab.visible !== false}
        scrollback={5000}
        exited={exited}
        onStatus={(s) => setExited(s.status === 'exited')}
        onRestart={() => {
          setExited(false)
          setTerminalId(null)
          setNonce((n) => n + 1)
        }}
      />
    </div>
  )
}
