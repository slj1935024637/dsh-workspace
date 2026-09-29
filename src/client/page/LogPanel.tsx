/*
 * @Description: 连接日志面板 —— 失败原因（detail）直接展开可见
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/LogPanel.tsx
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconRefresh } from '../icons.js'
import type { ConnectionLogEntry, HostView } from '../../types.js'
import type { Translate } from '../context.js'
import type { WorkspaceModel } from './useWorkspace.js'

const POLL_MS = 3000

export function LogPanel(props: {
  t: Translate
  model: WorkspaceModel
  hosts: HostView[]
  /** 选中某台主机时只看它的日志；null 表示全部。 */
  hostId: string | null
  onHostChange: (id: string | null) => void
}) {
  const { t, model } = props
  const call = model.call
  const [entries, setEntries] = useState<ConnectionLogEntry[]>([])

  // 依赖稳定的 call 而不是整个 model：model 每次状态轮询都换身份，
  // 依赖它会让本面板每 3 秒额外重启一次定时器并多拉一次日志。
  const load = useCallback(async () => {
    try {
      const list = await call('logs', {
        ...(props.hostId !== null ? { hostId: props.hostId } : {}),
        limit: 200
      })
      setEntries(list)
    } catch {
      // 日志拉取失败不打扰用户，下一轮轮询自动重试。
    }
  }, [call, props.hostId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const labelOf = (id: string): string =>
    id === '' ? 'system' : (props.hosts.find((h) => h.id === id)?.label ?? id.slice(0, 8))

  return (
    <section className="dshws-log">
      <div className="dshws-log-head">
        <span className="dshws-log-title">{t('log.title')}</span>
        <select
          className="dshws-select"
          style={{ width: 200 }}
          value={props.hostId ?? ''}
          onChange={(e) => props.onHostChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{t('log.all')}</option>
          {props.hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </select>
        <button type="button" className="dshws-icon-btn" title={t('log.refresh')} onClick={() => void load()}>
          <IconRefresh size={14} />
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void model
              .call('clearLogs', props.hostId !== null ? { hostId: props.hostId } : {})
              .then(load)
          }}
        >
          {t('log.clear')}
        </Button>
      </div>
      <div className="dshws-log-body">
        {entries.length === 0 ? (
          <div className="dshws-log-empty">{t('log.empty')}</div>
        ) : (
          entries.map((entry) => (
            <div className="dshws-log-row" data-level={entry.level} key={entry.id}>
              <span className="dshws-log-time">{new Date(entry.at).toLocaleTimeString()}</span>
              <span className="dshws-log-level">{entry.level.toUpperCase()}</span>
              <span className="dshws-log-stage">{props.hostId === null ? labelOf(entry.hostId) : entry.stage}</span>
              <div className="dshws-log-msg">
                {entry.message}
                {entry.detail !== undefined ? (
                  // 只展示首行 + 首个 at 帧：完整栈对用户无用，但根因必须可见。
                  <div className="dshws-log-detail">{summarize(entry.detail)}</div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function summarize(detail: string): string {
  const lines = detail.split('\n').filter((l) => l.trim() !== '')
  return lines.slice(0, 2).join('\n')
}
