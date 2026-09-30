/*
 * @Description: 「全局配置」里的更新卡片 —— 检查更新、下载并更新、上传离线包、重启 DSH
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/client/page/UpdateSection.tsx
 *
 * 安装在宿主后台执行（pnpm 可能要一两分钟），这里只在有任务进行时每秒轮询一次 updateStatus。
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import { ERROR_CODES, UPDATE_HTTP_PREFIX } from '../../wire/contract.js'
import type { UpdateStatus, UploadView } from '../../wire/dto.js'
import { formatSize } from '../files/transfer.js'
import { isDesktopRenderer } from '../host-url.js'
import { clearAwaiting, markAwaiting, readAwaiting } from './update-flag.js'
import { useDialogs } from './dialogs.js'
import type { useWorkspace } from './useWorkspace.js'

export interface UpdateSectionProps {
  t: Translate
  call: ReturnType<typeof useWorkspace>['call']
  onError(error: unknown): void
}

const POLL_MS = 1000

function isBusy(status: UpdateStatus | null): boolean {
  const phase = status?.job.phase
  return phase === 'downloading' || phase === 'verifying' || phase === 'installing'
}

/** 上传离线包（原始字节，同源相对地址：桌面版只给同源请求附令牌）。 */
function uploadPackage(file: File): Promise<UploadView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${UPDATE_HTTP_PREFIX}/upload`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.onload = () => {
      let body: { upload?: UploadView; message?: unknown } = {}
      try {
        body = JSON.parse(xhr.responseText) as typeof body
      } catch {
        /* 非 JSON：按状态码报错 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.upload !== undefined) resolve(body.upload)
      else reject(new Error(typeof body.message === 'string' ? body.message : `上传失败（HTTP ${xhr.status}）`))
    }
    xhr.onerror = () => reject(new Error('网络错误，上传中断。'))
    xhr.send(file)
  })
}

/**
 * 重启 DSH：桌面版优先走 preload 暴露的 dshDesktopActions（与宿主设置页一致，宿主进程退出时也能用），
 * 否则调用宿主的 /api/desktop/restart。都不行返回 false，界面提示手动重启。
 */
async function restartDsh(): Promise<boolean> {
  const bridge = (globalThis as { dshDesktopActions?: { invoke?: (action: string) => Promise<unknown> } }).dshDesktopActions
  try {
    if (typeof bridge?.invoke === 'function') {
      await bridge.invoke('restart')
      return true
    }
    const res = await fetch('/api/desktop/restart', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}'
    })
    return res.ok
  } catch {
    return false
  }
}

export function UpdateSection(props: UpdateSectionProps) {
  const { t } = props
  const dialogs = useDialogs()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [upload, setUpload] = useState<UploadView | null>(null)
  const [restartState, setRestartState] = useState<'idle' | 'restarting' | 'manual'>('idle')
  const [showNotes, setShowNotes] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void props.call('updateStatus', {}).then(setStatus, props.onError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 有任务进行时轮询进度；结束即停。
  const busy = isBusy(status)
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => {
      void props.call('updateStatus', {}).then(setStatus, () => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  const devBuild = status !== null && !/^\d+\.\d+\.\d+/.test(status.current)

  const check = (): void => {
    setChecking(true)
    setCheckError(null)
    void props
      .call('updateCheck', { force: true })
      .then(setStatus, (error: unknown) => setCheckError(error instanceof Error ? error.message : String(error)))
      .finally(() => setChecking(false))
  }

  const installLatest = async (): Promise<void> => {
    const version = status?.latest?.version
    if (version === undefined) return
    const ok = await dialogs.confirm({ title: t('update.install'), message: t('update.confirmInstall', { version }), confirmLabel: t('update.install') })
    if (!ok) return
    try {
      setStatus(await props.call('updateInstall', { source: 'latest' }))
      // 安装完成时宿主会重载本插件的浏览器端代码、把页面关掉：记下来，重载后回到这里提示重启。
      markAwaiting(version)
    } catch (error) {
      props.onError(error)
    }
  }

  const pickFile = async (file: File): Promise<void> => {
    setUploading(true)
    setUpload(null)
    try {
      setUpload(await uploadPackage(file))
    } catch (error) {
      props.onError(error)
    } finally {
      setUploading(false)
    }
  }

  const installUpload = async (): Promise<void> => {
    if (upload === null) return
    const ok = await dialogs.confirm({
      title: t('update.installUpload'),
      message: (
        <>
          {t('update.confirmUpload')}
          <br />
          {t('update.uploadInfo', { version: upload.info.version, size: formatSize(upload.info.size), sha: upload.info.sha256.slice(0, 16) })}（{t(`update.relation.${upload.relation}`)}）
        </>
      ),
      confirmLabel: t('update.installUpload'),
      danger: upload.relation === 'older'
    })
    if (!ok) return
    try {
      setStatus(await props.call('updateInstall', { source: 'upload', token: upload.token }))
      markAwaiting(upload.info.version)
      setUpload(null)
    } catch (error) {
      // 令牌失效（例如宿主重启过）：清掉上传结果，让用户重新选择文件。
      if ((error as { code?: string }).code === ERROR_CODES.failed) setUpload(null)
      props.onError(error)
    }
  }

  // 桌面版能一键重启（dshDesktopActions / /api/desktop/restart）；网页版只能提示用户手动重启。
  const canRestart = isDesktopRenderer()
  const bannerRef = useRef<HTMLDivElement>(null)

  const restart = async (): Promise<void> => {
    setRestartState('restarting')
    setRestartState((await restartDsh()) ? 'restarting' : 'manual')
  }

  const job = status?.job
  const latest = status?.latest
  const pendingVersion = status?.pending ?? (job?.phase === 'done' ? job.version : undefined)
  const canInstall = status?.installer === true && !busy

  /**
   * 安装刚完成（这一轮从「进行中」变成「完成」）：弹窗提示重启，并把重启提示滚到视野里。
   * 只在本页亲眼看到安装完成时弹一次；刷新页面后仍待重启的，只显示顶部的提示条，不再弹窗打扰。
   */
  const lastPhase = useRef(job?.phase)
  useEffect(() => {
    const before = lastPhase.current
    lastPhase.current = job?.phase
    if (status === null || job === undefined) return
    if (job.phase === 'failed') {
      clearAwaiting()
      return
    }
    // 两种情况弹窗：本页亲眼看到从「进行中」变成「完成」；或者安装时页面被宿主重载关掉了（标记还在），回来时已装好。
    const awaiting = readAwaiting()
    // 后台已经是新版本（例如用户已自行重启）：标记作废，不再提示。
    if (awaiting !== null && status.current === awaiting.version) {
      clearAwaiting()
      return
    }
    const sawFinish = job.phase === 'done' && before !== undefined && before !== 'done' && before !== 'idle' && before !== 'failed'
    const resumed = awaiting !== null && (job.phase === 'done' || status.pending !== undefined)
    if (!sawFinish && !resumed) return
    clearAwaiting()
    const version = status.pending ?? job.version ?? awaiting?.version ?? ''
    bannerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    void dialogs
      .confirm({
        title: t('update.doneTitle'),
        message: canRestart ? t('update.doneMessage', { version }) : t('update.doneMessageManual', { version }),
        confirmLabel: canRestart ? t('update.restart') : t('update.gotIt'),
        cancelLabel: t('update.later'),
        hideCancel: !canRestart
      })
      .then((ok) => {
        if (ok && canRestart) void restart()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.phase, status?.pending])

  return (
    <section className="dshws-set-card">
      <div className="dshws-section-title">{t('update.title')}</div>

      {/* 待重启提示条：安装完成后常驻（含刷新页面后），直到重启把新版本加载进来。 */}
      {!busy && pendingVersion !== undefined && job?.phase !== 'failed' ? (
        <div ref={bannerRef} className="dshws-update-restart" role="status">
          <svg className="dshws-update-restart-ico" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6" />
          </svg>
          <div className="dshws-update-restart-text">
            <div className="dshws-update-restart-title">{t('update.pending', { version: pendingVersion })}</div>
            <div className="dshws-update-restart-desc">
              {canRestart && restartState !== 'manual' ? t('update.pendingHint') : t('update.restartManual')}
            </div>
          </div>
          {canRestart && restartState !== 'manual' ? (
            <Button size="sm" variant="primary" disabled={restartState === 'restarting'} onClick={() => void restart()}>
              {restartState === 'restarting' ? t('update.restarting') : t('update.restart')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="dshws-set-row">
        <div className="dshws-set-text">
          <div className="dshws-set-title">
            {latest === undefined
              ? t('update.check')
              : latest.newer
                ? t('update.available', { version: latest.version })
                : t('update.upToDate', { version: status?.current ?? '' })}
          </div>
          <div className="dshws-set-desc">
            {devBuild ? t('update.devBuild') : latest === undefined ? t('update.checkHint') : t(`update.source.${latest.source}`)}
            {latest !== undefined ? (
              <>
                {' · '}
                <a className="dshws-set-link" href={latest.pageUrl} target="_blank" rel="noreferrer noopener">
                  {t('update.openPage')}
                </a>
                {latest.notes !== '' ? (
                  <>
                    {' · '}
                    <button type="button" className="dshws-link-button" onClick={() => setShowNotes((v) => !v)}>
                      {t('update.notes')}
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
            {checkError !== null ? <span className="dshws-set-note">{checkError}</span> : null}
            {status !== null && !status.installer ? <span className="dshws-set-note">{t('update.noInstaller')}</span> : null}
          </div>
        </div>
        <div className="dshws-set-control dshws-set-actions">
          <Button size="sm" variant="outline" disabled={checking || busy || devBuild} onClick={check}>
            {checking ? t('update.checking') : t('update.check')}
          </Button>
          {latest?.newer === true ? (
            <Button size="sm" disabled={!canInstall} onClick={() => void installLatest()}>
              {t('update.install')}
            </Button>
          ) : null}
        </div>
      </div>
      {showNotes && latest !== undefined && latest.notes !== '' ? <pre className="dshws-update-notes">{latest.notes}</pre> : null}

      <div className="dshws-set-row">
        <div className="dshws-set-text">
          <div className="dshws-set-title">{t('update.upload')}</div>
          <div className="dshws-set-desc">
            {upload === null
              ? t('update.uploadHint')
              : `${t('update.uploadInfo', { version: upload.info.version, size: formatSize(upload.info.size), sha: upload.info.sha256.slice(0, 16) })}（${t(`update.relation.${upload.relation}`)}）`}
          </div>
        </div>
        <div className="dshws-set-control dshws-set-actions">
          <Button size="sm" variant="outline" disabled={uploading || busy} onClick={() => fileRef.current?.click()}>
            {uploading ? t('update.uploading') : t('update.upload')}
          </Button>
          {upload !== null ? (
            <>
              <Button size="sm" disabled={!canInstall} onClick={() => void installUpload()}>
                {t('update.installUpload')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setUpload(null)}>
                {t('update.cancel')}
              </Button>
            </>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".tgz,application/gzip,application/x-gzip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file !== undefined) void pickFile(file)
          }}
        />
      </div>

      {busy && job !== undefined ? (
        <div className="dshws-update-progress" role="status">
          <span className="dshws-spinner" aria-hidden="true" />
          <span>
            {t(`update.phase.${job.phase}`, { version: job.version ?? '' })}
            {job.phase === 'downloading' && job.received !== undefined
              ? ` ${formatSize(job.received)}${job.total !== undefined ? ` / ${formatSize(job.total)}` : ''}`
              : ''}
          </span>
        </div>
      ) : null}
      {job?.phase === 'failed' ? <pre className="dshws-update-error">{job.message}</pre> : null}

    </section>
  )
}
