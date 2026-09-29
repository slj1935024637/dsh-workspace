/*
 * @Description: 「全局配置」页签 —— 插件级开关（接管添加工作区、自动解锁）与关于信息（版本、更新日志等链接）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/SettingsPane.tsx
 *
 * 宿主 Switch 只把 label 当 aria-label、不显示文字（它本身是 <button role="switch">），
 * 所以每行的标题与说明自己画在左侧，开关在右侧。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import { LINKS, VERSION } from '../build-info.js'
import { emitTakeoverChange } from '../workspace/takeover.js'
import type { useWorkspace } from './useWorkspace.js'

export interface SettingsPaneProps {
  t: Translate
  call: ReturnType<typeof useWorkspace>['call']
  /** 保险箱尚未初始化时为 null（自动解锁不可用）。 */
  autoUnlock: { enabled: boolean; scheme: string } | null
  /** 开启自动解锁：由页面弹出确认主密码的对话框。 */
  onEnableAutoUnlock(): void
  onDisableAutoUnlock(): void
  onError(error: unknown): void
}

/** 一行配置：左侧标题 + 说明，右侧控件。 */
function SettingRow(props: { title: string; desc: ReactNode; control: ReactNode; disabled?: boolean }) {
  return (
    <div className="dshws-set-row" data-disabled={props.disabled === true}>
      <div className="dshws-set-text">
        <div className="dshws-set-title">{props.title}</div>
        <div className="dshws-set-desc">{props.desc}</div>
      </div>
      <div className="dshws-set-control">{props.control}</div>
    </div>
  )
}

function ExternalLink(props: { href: string; children: ReactNode }) {
  return (
    <a className="dshws-set-link" href={props.href} target="_blank" rel="noreferrer noopener">
      {props.children}
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
      </svg>
    </a>
  )
}

export function SettingsPane(props: SettingsPaneProps) {
  const { t } = props
  const [takeover, setTakeover] = useState<boolean | null>(null)

  useEffect(() => {
    void props.call('getPrefs', {}).then((p) => setTakeover(p.takeoverAddWorkspace), props.onError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeTakeover = (next: boolean): void => {
    setTakeover(next)
    void props.call('setTakeover', { enabled: next }).then(
      (p) => {
        setTakeover(p.takeoverAddWorkspace)
        // 通知入口即时注册 / 撤下插槽，不用刷新。
        emitTakeoverChange(p.takeoverAddWorkspace)
      },
      (error: unknown) => {
        // 写偏好失败：回滚开关并提示，而不是悄悄弹回去。
        setTakeover(!next)
        props.onError(error)
      }
    )
  }

  const autoUnlock = props.autoUnlock

  return (
    <div className="dshws-settings">
      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('settings.general')}</div>
        <SettingRow
          title={t('settings.takeover')}
          desc={t('settings.takeoverHint')}
          disabled={takeover === null}
          control={<Switch checked={takeover === true} label={t('settings.takeover')} disabled={takeover === null} onChange={changeTakeover} />}
        />
        <SettingRow
          title={t('vault.autoUnlock')}
          desc={
            <>
              {t('vault.autoUnlockHint')}
              {autoUnlock === null ? <span className="dshws-set-note">{t('settings.autoUnlockNeedsVault')}</span> : null}
              {autoUnlock !== null && autoUnlock.scheme !== 'dpapi' ? <span className="dshws-set-note">{t('settings.autoUnlockPlain')}</span> : null}
            </>
          }
          disabled={autoUnlock === null}
          control={
            <Switch
              checked={autoUnlock?.enabled === true}
              label={t('vault.autoUnlock')}
              disabled={autoUnlock === null}
              onChange={(next) => (next ? props.onEnableAutoUnlock() : props.onDisableAutoUnlock())}
            />
          }
        />
      </section>

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('about.title')}</div>
        <div className="dshws-about">
          <div className="dshws-about-head">
            <span className="dshws-about-name">dsh-workspace</span>
            <span className="dshws-about-ver">v{VERSION}</span>
          </div>
          <p className="dshws-about-desc">{t('about.desc')}</p>
          <dl className="dshws-kv dshws-about-kv">
            <dt>{t('about.version')}</dt>
            <dd>{VERSION}</dd>
            <dt>{t('about.author')}</dt>
            <dd>YangHeng</dd>
            <dt>{t('about.license')}</dt>
            <dd>MIT</dd>
            <dt>{t('about.repo')}</dt>
            <dd>
              <ExternalLink href={LINKS.repo}>github.com/yh4922/dsh-workspace</ExternalLink>
            </dd>
          </dl>
          <div className="dshws-about-links">
            <ExternalLink href={LINKS.changelog}>{t('about.changelog')}</ExternalLink>
            <ExternalLink href={LINKS.releases}>{t('about.releases')}</ExternalLink>
            <ExternalLink href={LINKS.readme}>{t('about.readme')}</ExternalLink>
            <ExternalLink href={LINKS.issues}>{t('about.issues')}</ExternalLink>
          </div>
        </div>
      </section>
    </div>
  )
}
