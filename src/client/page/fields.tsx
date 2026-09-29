/*
 * @Description: 表单公共部件 —— 字段容器、分段选择、认证与代理区块、环境变量解析
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/fields.tsx
 */
import type { ReactNode } from 'react'
import type { HostAuthView, HostProxyView } from '../../types.js'
import type { AuthInput, ProxyInput } from '../../wire/dto.js'
import type { Translate } from '../context.js'

export function Field(props: {
  label: string
  required?: boolean
  hint?: string
  error?: string | undefined
  className?: string
  children: ReactNode
}) {
  return (
    <label className={`dshws-field ${props.className ?? ''}`}>
      <span className="dshws-label">
        {props.label}
        {props.required === true ? <span className="dshws-req">*</span> : null}
      </span>
      {props.children}
      {props.error !== undefined ? (
        <span className="dshws-field-error">{props.error}</span>
      ) : props.hint !== undefined ? (
        <span className="dshws-field-hint">{props.hint}</span>
      ) : null}
    </label>
  )
}

export function Segment<T extends string>(props: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="dshws-segment" role="radiogroup">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          data-active={props.value === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ 认证

// 表单不再提供 SSH Agent；底层仍保留该类型（旧数据要能读）。
export type AuthKind = 'inherit' | Exclude<AuthInput['kind'], 'agent'>

/** 认证区块的草稿态。凭据字段只在用户输入时才有值（空串 = 沿用已保存的）。 */
export interface AuthDraft {
  kind: AuthKind
  password: string
  keyPath: string
  keyContent: string
  passphrase: string
  clearPassphrase: boolean
}

export function authDraftFrom(view: HostAuthView | null | undefined): AuthDraft {
  // 不再提供「SSH Agent」：旧数据里 agent 认证的主机按「密码」展示。
  // 只改展示方式，不动数据 —— 未改动认证区块时保存不会改动它的 auth。
  const kind: AuthKind =
    view === null || view === undefined ? 'inherit' : view.kind === 'agent' ? 'password' : view.kind
  return {
    kind,
    password: '',
    keyPath: view?.keyPath ?? '',
    keyContent: '',
    passphrase: '',
    clearPassphrase: false
  }
}

/**
 * 草稿 → 输入。
 * @param touched 用户是否动过认证区块。没动过就返回 undefined（「不改」），
 *                这样编辑主机名之类的操作不会触发解锁要求。
 */
export function authInputFrom(draft: AuthDraft, touched: boolean): AuthInput | null | undefined {
  if (!touched) return undefined
  switch (draft.kind) {
    case 'inherit':
      return null
    case 'password':
      return { kind: 'password', ...(draft.password !== '' ? { password: draft.password } : {}) }
    case 'keyPath':
      return {
        kind: 'keyPath',
        keyPath: draft.keyPath,
        ...(draft.passphrase !== '' ? { passphrase: draft.passphrase } : {}),
        ...(draft.clearPassphrase ? { clearPassphrase: true } : {})
      }
    case 'keyContent':
      return {
        kind: 'keyContent',
        ...(draft.keyContent !== '' ? { keyContent: draft.keyContent } : {}),
        ...(draft.passphrase !== '' ? { passphrase: draft.passphrase } : {}),
        ...(draft.clearPassphrase ? { clearPassphrase: true } : {})
      }
  }
}

export function AuthFields(props: {
  t: Translate
  draft: AuthDraft
  saved: HostAuthView | null | undefined
  allowInherit: boolean
  onChange: (next: AuthDraft) => void
}) {
  const { t, draft, saved } = props
  const set = (patch: Partial<AuthDraft>) => props.onChange({ ...draft, ...patch })
  // 只有「保存的类型与当前选择一致」时，已保存的凭据才可沿用。
  const sameKind = saved !== null && saved !== undefined && saved.kind === draft.kind
  const secretPlaceholder = sameKind && saved.hasSecret ? t('form.secretKeep') : ''
  const passphrasePlaceholder =
    sameKind && saved.hasPassphrase ? t('form.secretKeep') : t('form.secretEmpty')

  const options: Array<{ value: AuthKind; label: string }> = [
    ...(props.allowInherit ? [{ value: 'inherit' as const, label: t('form.authInherit') }] : []),
    { value: 'password', label: t('form.authPassword') },
    { value: 'keyPath', label: t('form.authKeyPath') },
    { value: 'keyContent', label: t('form.authKeyContent') }
  ]

  return (
    <div className="dshws-grid">
      <div className="dshws-span-2">
        <Segment value={draft.kind} options={options} onChange={(kind) => set({ kind })} />
      </div>

      {draft.kind === 'password' ? (
        <Field label={t('form.password')} className="dshws-span-2">
          <input
            className="dshws-input"
            type="password"
            autoComplete="new-password"
            value={draft.password}
            placeholder={secretPlaceholder}
            onChange={(e) => set({ password: e.target.value })}
          />
        </Field>
      ) : null}

      {draft.kind === 'keyPath' ? (
        <Field label={t('form.keyPath')} className="dshws-span-2">
          <input
            className="dshws-input dshws-mono"
            value={draft.keyPath}
            placeholder={t('form.keyPathPlaceholder')}
            onChange={(e) => set({ keyPath: e.target.value })}
          />
        </Field>
      ) : null}

      {draft.kind === 'keyContent' ? (
        <Field label={t('form.keyContent')} className="dshws-span-2">
          <textarea
            className="dshws-textarea dshws-mono"
            rows={5}
            spellCheck={false}
            value={draft.keyContent}
            placeholder={secretPlaceholder !== '' ? secretPlaceholder : '-----BEGIN OPENSSH PRIVATE KEY-----'}
            onChange={(e) => set({ keyContent: e.target.value })}
          />
        </Field>
      ) : null}

      {draft.kind === 'keyPath' || draft.kind === 'keyContent' ? (
        <Field label={t('form.passphrase')} className="dshws-span-2">
          <input
            className="dshws-input"
            type="password"
            autoComplete="new-password"
            value={draft.passphrase}
            disabled={draft.clearPassphrase}
            placeholder={passphrasePlaceholder}
            onChange={(e) => set({ passphrase: e.target.value })}
          />
          {sameKind && saved.hasPassphrase ? (
            <span className="dshws-check">
              <input
                type="checkbox"
                checked={draft.clearPassphrase}
                onChange={(e) => set({ clearPassphrase: e.target.checked, passphrase: '' })}
              />
              {t('form.clearPassphrase')}
            </span>
          ) : null}
        </Field>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ 代理

export interface ProxyDraft {
  enabled: boolean
  kind: ProxyInput['kind']
  host: string
  port: string
  username: string
  password: string
  clearPassword: boolean
}

export function proxyDraftFrom(view: HostProxyView | null | undefined): ProxyDraft {
  return {
    enabled: view !== null && view !== undefined,
    kind: view?.kind ?? 'http',
    host: view?.host ?? '',
    port: view !== null && view !== undefined ? String(view.port) : '',
    username: view?.username ?? '',
    password: '',
    clearPassword: false
  }
}

export function proxyInputFrom(draft: ProxyDraft, touched: boolean): ProxyInput | null | undefined {
  if (!touched) return undefined
  if (!draft.enabled) return null
  return {
    kind: draft.kind,
    host: draft.host.trim(),
    port: Number(draft.port),
    ...(draft.username.trim() !== '' ? { username: draft.username.trim() } : {}),
    ...(draft.password !== '' ? { password: draft.password } : {}),
    ...(draft.clearPassword ? { clearPassword: true } : {})
  }
}

export function ProxyFields(props: {
  t: Translate
  draft: ProxyDraft
  saved: HostProxyView | null | undefined
  onChange: (next: ProxyDraft) => void
}) {
  const { t, draft, saved } = props
  const set = (patch: Partial<ProxyDraft>) => props.onChange({ ...draft, ...patch })
  const mode = draft.enabled ? draft.kind : 'none'

  return (
    <div className="dshws-grid">
      <div className="dshws-span-2">
        <Segment
          value={mode}
          options={[
            { value: 'none', label: t('form.proxyNone') },
            { value: 'http', label: 'HTTP' },
            { value: 'socks5', label: 'SOCKS5' }
          ]}
          onChange={(value) =>
            value === 'none' ? set({ enabled: false }) : set({ enabled: true, kind: value })
          }
        />
      </div>
      {draft.enabled ? (
        <>
          <Field label={t('form.proxyHost')} required>
            <input className="dshws-input" value={draft.host} onChange={(e) => set({ host: e.target.value })} />
          </Field>
          <Field label={t('form.proxyPort')} required>
            <input
              className="dshws-input"
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
          <Field label={t('form.proxyUser')}>
            <input className="dshws-input" value={draft.username} onChange={(e) => set({ username: e.target.value })} />
          </Field>
          <Field label={t('form.proxyPassword')}>
            <input
              className="dshws-input"
              type="password"
              autoComplete="new-password"
              value={draft.password}
              disabled={draft.clearPassword}
              placeholder={saved?.hasPassword === true ? t('form.secretKeep') : ''}
              onChange={(e) => set({ password: e.target.value })}
            />
            {saved?.hasPassword === true ? (
              <span className="dshws-check">
                <input
                  type="checkbox"
                  checked={draft.clearPassword}
                  onChange={(e) => set({ clearPassword: e.target.checked, password: '' })}
                />
                {t('form.clearProxyPassword')}
              </span>
            ) : null}
          </Field>
        </>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ 环境变量

export function formatEnv(env: Record<string, string> | undefined): string {
  if (env === undefined) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** 解析 KEY=VALUE 行。返回错误行号（1 起）或结果。空行与 # 注释行跳过。 */
export function parseEnv(text: string): { ok: true; env: Record<string, string> } | { ok: false; line: number } {
  const env: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) return { ok: false, line: i + 1 }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return { ok: true, env }
}

export function validPort(text: string): boolean {
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}
