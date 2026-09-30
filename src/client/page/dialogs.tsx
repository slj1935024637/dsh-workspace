/*
 * @Description: 页内对话框服务 —— 替代 window.prompt / window.confirm
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/dialogs.tsx
 *
 * 为什么不用浏览器原生对话框：DSH Desktop 是 Electron，Electron 不支持 window.prompt()
 * （调用即抛错），表现为「点新建文件夹没反应」。confirm 虽能用，但会阻塞整个渲染进程、
 * 样式也与宿主不一致，所以一并换成宿主 Modal，统一走 Promise 接口。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'

export interface PromptOptions {
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  /** 返回错误文案则阻止提交（如名称含 /）。 */
  validate?: (value: string) => string | undefined
  /** 默认只选中「文件名」部分（不含扩展名），与常见文件管理器一致。 */
  selectBaseName?: boolean
}

export interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
  /** 取消按钮文字（默认「取消」）；hideCancel 时只保留确认按钮。 */
  cancelLabel?: string
  hideCancel?: boolean
  danger?: boolean
}

export interface Dialogs {
  prompt(options: PromptOptions): Promise<string | null>
  confirm(options: ConfirmOptions): Promise<boolean>
}

const DialogContext = createContext<Dialogs | null>(null)

/** 取对话框服务。必须在 DialogProvider 之内使用。 */
export function useDialogs(): Dialogs {
  const value = useContext(DialogContext)
  if (value === null) throw new Error('useDialogs 必须在 DialogProvider 之内使用')
  return value
}

type Pending =
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }

export function DialogProvider(props: { t: Translate; children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([])
  const current = queue[0]

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => setQueue((q) => [...q, { kind: 'prompt', options, resolve }])),
    []
  )
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setQueue((q) => [...q, { kind: 'confirm', options, resolve }])),
    []
  )
  // 服务对象身份稳定，调用方可放心放进依赖数组。
  const api = useRef<Dialogs>({ prompt, confirm }).current

  const finish = (value: string | boolean | null): void => {
    if (current === undefined) return
    if (current.kind === 'prompt') current.resolve(typeof value === 'string' ? value : null)
    else current.resolve(value === true)
    setQueue((q) => q.slice(1))
  }

  return (
    <DialogContext.Provider value={api}>
      {props.children}
      {current?.kind === 'prompt' ? (
        <PromptDialog key={queue.length} t={props.t} options={current.options} onDone={finish} />
      ) : null}
      {current?.kind === 'confirm' ? (
        <Modal
          open
          title={current.options.title}
          closeLabel={props.t('common.close')}
          onClose={() => finish(false)}
          footer={
            <div className="dshws-dialog-actions">
              {current.options.hideCancel === true ? null : (
                <Button size="sm" variant="outline" onClick={() => finish(false)}>
                  {current.options.cancelLabel ?? props.t('form.cancel')}
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                className={current.options.danger === true ? 'dshws-danger-btn' : undefined}
                onClick={() => finish(true)}
              >
                {current.options.confirmLabel ?? props.t('common.confirm')}
              </Button>
            </div>
          }
        >
          <div className="dshws-dialog-message">{current.options.message}</div>
        </Modal>
      ) : null}
    </DialogContext.Provider>
  )
}

function PromptDialog(props: { t: Translate; options: PromptOptions; onDone: (value: string | null) => void }) {
  const { t, options } = props
  const [value, setValue] = useState(options.defaultValue ?? '')
  const [error, setError] = useState<string | undefined>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Modal 打开动画完成前聚焦可能落空，延后一帧。
    const timer = setTimeout(() => {
      const input = inputRef.current
      if (input === null) return
      input.focus()
      const dot = input.value.lastIndexOf('.')
      if (options.selectBaseName === true && dot > 0) input.setSelectionRange(0, dot)
      else input.select()
    }, 30)
    return () => clearTimeout(timer)
  }, [options.selectBaseName])

  const submit = (): void => {
    const trimmed = value.trim()
    if (trimmed === '') {
      setError(t('dialog.required'))
      return
    }
    const problem = options.validate?.(trimmed)
    if (problem !== undefined) {
      setError(problem)
      return
    }
    props.onDone(trimmed)
  }

  return (
    <Modal
      open
      title={options.title}
      closeLabel={t('common.close')}
      onClose={() => props.onDone(null)}
      footer={
        <div className="dshws-dialog-actions">
          <Button size="sm" variant="outline" onClick={() => props.onDone(null)}>
            {t('form.cancel')}
          </Button>
          <Button size="sm" variant="primary" onClick={submit}>
            {t('common.confirm')}
          </Button>
        </div>
      }
    >
      <form
        className="dshws-dialog-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {options.label !== undefined ? <label className="dshws-field-label">{options.label}</label> : null}
        <input
          ref={inputRef}
          className="dshws-input"
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            setError(undefined)
          }}
        />
        {error !== undefined ? <div className="dshws-field-error">{error}</div> : null}
      </form>
    </Modal>
  )
}

/** 远端文件名校验（与宿主端 validateName 一致，提前在界面上拦下）。 */
export function fileNameProblem(t: Translate): (value: string) => string | undefined {
  return (value) => {
    if (value === '.' || value === '..') return t('dialog.badName')
    if (/[/\0]/.test(value)) return t('dialog.badName')
    return undefined
  }
}
