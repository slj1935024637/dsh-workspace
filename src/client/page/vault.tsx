/*
 * @Description: 保险箱相关界面 —— 设置 / 解锁横幅、修改主密码、主机指纹变更警告
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/vault.tsx
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { HostKeyAlert } from './useWorkspace.js'
import { messageOf } from './useWorkspace.js'
import { Field } from './fields.js'

/** 未设置主密码时的引导横幅。 */
export function SetupBanner(props: { t: Translate; onSetup: (password: string) => Promise<void> }) {
  const { t } = props
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (password.length < 6) {
      setError(t('vault.tooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('vault.mismatch'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.onSetup(password)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dshws-banner" data-tone="warn">
      <div className="dshws-banner-text">
        <div className="dshws-banner-title">{t('vault.setupTitle')}</div>
        <div className="dshws-banner-hint">{t('vault.setupHint')}</div>
        {error !== null ? <div className="dshws-field-error">{error}</div> : null}
      </div>
      <form
        className="dshws-banner-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          className="dshws-input"
          type="password"
          autoComplete="new-password"
          placeholder={t('vault.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className="dshws-input"
          type="password"
          autoComplete="new-password"
          placeholder={t('vault.confirm')}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {/* primitives 的 Button 把 type 写死为 "button"，不会触发表单提交；
            这里用 onClick 驱动，并放一个隐藏的原生 submit 让回车键仍可提交。 */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          {t('vault.setup')}
        </Button>
      </form>
    </div>
  )
}

/**
 * 已锁定时的解锁横幅。
 * @param attention 由 vault-locked 错误触发：自动聚焦输入框，引导用户立即解锁。
 */
export function UnlockBanner(props: {
  t: Translate
  attention: boolean
  onUnlock: (password: string) => Promise<boolean>
  /** 勾选「记住」时解锁成功后调用：开启自动解锁。 */
  onRemember?: (password: string) => Promise<void>
}) {
  const { t } = props
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.attention) inputRef.current?.focus()
  }, [props.attention])

  const submit = async (): Promise<void> => {
    if (password === '') return
    setBusy(true)
    setError(null)
    try {
      const ok = await props.onUnlock(password)
      if (!ok) setError(t('vault.wrong'))
      else {
        if (remember) await props.onRemember?.(password)
        setPassword('')
      }
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dshws-banner" data-tone={props.attention ? 'error' : undefined}>
      <div className="dshws-banner-text">
        <div className="dshws-banner-title">{t('vault.lockedTitle')}</div>
        <div className="dshws-banner-hint">{t('vault.lockedHint')}</div>
        {error !== null ? <div className="dshws-field-error">{error}</div> : null}
      </div>
      <form
        className="dshws-banner-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          ref={inputRef}
          className="dshws-input"
          type="password"
          autoComplete="current-password"
          placeholder={t('vault.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <Button variant="primary" size="sm" disabled={busy || password === ''} onClick={() => void submit()}>
          {t('vault.unlock')}
        </Button>
        {props.onRemember !== undefined ? (
          <label className="dshws-check" title={t('vault.autoUnlockHint')}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('vault.rememberHere')}
          </label>
        ) : null}
      </form>
    </div>
  )
}

/** 开启自动解锁：再输入一次主密码确认。 */
export function AutoUnlockDialog(props: {
  t: Translate
  open: boolean
  scheme: 'dpapi' | 'file'
  onClose: () => void
  onEnable: (password: string) => Promise<boolean>
}) {
  const { t } = props
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (password === '') return
    setBusy(true)
    setError(null)
    try {
      if (await props.onEnable(password)) {
        setPassword('')
        props.onClose()
      } else setError(t('vault.wrong'))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={t('vault.autoUnlock')}
      closeLabel={t('common.close')}
      footer={
        <div className="dshws-footer">
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            {t('form.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || password === ''}>
            {t('vault.autoUnlockEnable')}
          </Button>
        </div>
      }
    >
      <form
        className="dshws-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="dshws-dialog-message">{t(props.scheme === 'dpapi' ? 'vault.autoUnlockDpapi' : 'vault.autoUnlockFile')}</div>
        {error !== null ? <div className="dshws-form-error">{error}</div> : null}
        <Field label={t('vault.password')}>
          <input className="dshws-input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}

export function ChangePasswordDialog(props: {
  t: Translate
  open: boolean
  onClose: () => void
  onChange: (oldPassword: string, newPassword: string) => Promise<boolean>
}) {
  const { t } = props
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (newPassword.length < 6) return setError(t('vault.tooShort'))
    if (newPassword !== confirm) return setError(t('vault.mismatch'))
    setBusy(true)
    setError(null)
    try {
      const ok = await props.onChange(oldPassword, newPassword)
      if (ok) props.onClose()
      else setError(t('vault.wrong'))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={t('vault.change')}
      closeLabel={t('common.close')}
      footer={
        <div className="dshws-footer">
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            {t('form.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {t('form.save')}
          </Button>
        </div>
      }
    >
      <div className="dshws-form">
        {error !== null ? <div className="dshws-form-error">{error}</div> : null}
        <Field label={t('vault.oldPassword')}>
          <input
            className="dshws-input"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOld(e.target.value)}
          />
        </Field>
        <Field label={t('vault.newPassword')}>
          <input
            className="dshws-input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
          />
        </Field>
        <Field label={t('vault.confirm')}>
          <input
            className="dshws-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * 主机指纹变更警告。
 *
 * 这是安全事件：必须并排展示新旧指纹供人工核对，且「信任」必须是用户的显式动作。
 * 信任走的是 forgetHostKey（遗忘旧记录），下次连接会按 TOFU 重新记录。
 */
export function HostKeyDialog(props: {
  t: Translate
  alert: HostKeyAlert | null
  onClose: () => void
  onTrust: (hostId: string) => Promise<void>
}) {
  const { t, alert } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Modal
      open={alert !== null}
      onClose={props.onClose}
      title={t('hostKey.title')}
      closeLabel={t('common.close')}
      footer={
        <div className="dshws-footer">
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            {t('form.cancel')}
          </Button>
          {alert !== null && alert.hostId !== '' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                props
                  .onTrust(alert.hostId)
                  .then(props.onClose)
                  .catch((e: unknown) => setError(messageOf(e)))
                  .finally(() => setBusy(false))
              }}
            >
              {t('hostKey.trust')}
            </Button>
          ) : null}
        </div>
      }
    >
      {alert !== null ? (
        <div className="dshws-form">
          {error !== null ? <div className="dshws-form-error">{error}</div> : null}
          <p style={{ margin: 0, lineHeight: 1.6 }}>{t('hostKey.body', { endpoint: alert.endpoint })}</p>
          <dl className="dshws-kv">
            <dt>{t('hostKey.expected')}</dt>
            <dd>{alert.expected}</dd>
            <dt>{t('hostKey.actual')}</dt>
            <dd>{alert.actual}</dd>
          </dl>
        </div>
      ) : null}
    </Modal>
  )
}
