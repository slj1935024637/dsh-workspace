/*
 * @Description: 接管 DSH 自带的「文件」侧栏（kind files）—— 冲突检测、状态广播
 * @Author: YangHeng
 * @Date: 2026-09-30 17:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/files-takeover.ts
 *
 * 宿主右侧栏注册表的规则（dsh-client-ui-sidebar-right tab-registry）：
 * - 同一 kind 只能有一个 builtin 加一个 extension；extension 生效、builtin 被遮蔽，extension 撤下后 builtin 自动恢复
 * - 同档第二个注册直接抛错
 * 所以只在当前生效的是 DSH 自带定义（builtin）时才接管；已被别的插件（如 better-sidebar）接管就不抢，
 * 只把状态告诉界面，由用户到那个插件里关掉它的「文件」标签 —— 关掉后注册表变化，这里自动补上接管。
 */

/** DSH 自带「文件」侧栏的定义 id。 */
export const BUILTIN_FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'
export const FILES_KIND = 'files'
/** 本插件接管 kind files 时用的定义 id（正文插槽按它取组件）。 */
export const TAKEOVER_FILES_ID = 'dsh-workspace:files'

export type TakeoverStatus =
  | { state: 'off' }
  | { state: 'pending' }
  | { state: 'active' }
  /** 已被其他插件接管；holder 为对方的定义 id。 */
  | { state: 'blocked'; holder: string }
  /** 宿主没有右侧栏注册表（旧版 / 精简环境）。 */
  | { state: 'unavailable' }

let status: TakeoverStatus = { state: 'pending' }
const listeners = new Set<() => void>()

export const filesTakeover = {
  status: (): TakeoverStatus => status,
  set(next: TakeoverStatus): void {
    if (JSON.stringify(next) === JSON.stringify(status)) return
    status = next
    for (const l of listeners) l()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

/** 开关变化（全局配置页切换后）的页内通知。 */
const toggles = new Set<(enabled: boolean) => void>()
export function onFilesTakeoverToggle(listener: (enabled: boolean) => void): () => void {
  toggles.add(listener)
  return () => {
    toggles.delete(listener)
  }
}
export function emitFilesTakeoverToggle(enabled: boolean): void {
  for (const l of toggles) l(enabled)
}

/** 注册表里本模块用到的部分。 */
export interface FilesRegistry {
  register(definition: { id: string; kind: string; priority?: 'extension' | 'builtin' | 'fallback'; title: (address: string) => string }): () => void
  get?(kind: string): { id: string } | undefined
  subscribe?(listener: () => void): () => void
}

/**
 * 按开关与注册表现状接管 / 让出 kind files。
 * @param mount 注册正文插槽，返回撤销函数
 * @returns 撤销全部（让出 kind、取消订阅）
 */
export function manageFilesTakeover(opts: {
  tabs: FilesRegistry
  title: () => string
  mount: () => () => void
  enabled: () => boolean
  /** 偏好读到之前不做判断（也不响应注册表通知）。 */
  ready: () => boolean
  log: (message: string, error?: unknown) => void
}): { evaluate(): void; dispose(): void } {
  let active: (() => void) | undefined
  let evaluating = false

  const release = (): void => {
    active?.()
    active = undefined
  }

  const evaluate = (): void => {
    // 自己注册时注册表会同步通知一次，这时不再重入。
    if (evaluating || !opts.ready()) return
    evaluating = true
    try {
      if (!opts.enabled()) {
        release()
        filesTakeover.set({ state: 'off' })
        return
      }
      if (active !== undefined) {
        filesTakeover.set({ state: 'active' })
        return
      }
      const holder = opts.tabs.get?.(FILES_KIND)?.id
      if (holder !== undefined && holder !== BUILTIN_FILES_ID) {
        filesTakeover.set({ state: 'blocked', holder })
        return
      }
      const offSlots = opts.mount()
      try {
        const off = opts.tabs.register({ id: TAKEOVER_FILES_ID, kind: FILES_KIND, priority: 'extension', title: opts.title })
        active = () => {
          off()
          offSlots()
        }
        filesTakeover.set({ state: 'active' })
      } catch (error) {
        offSlots()
        // 与别的 extension 撞上（对方刚好在这一刻注册）：按「已被接管」处理。
        filesTakeover.set({ state: 'blocked', holder: opts.tabs.get?.(FILES_KIND)?.id ?? 'unknown' })
        opts.log('接管「文件」侧栏失败', error)
      }
    } finally {
      evaluating = false
    }
  }

  const offRegistry = opts.tabs.subscribe?.(() => {
    // 注册表通知在对方 register 的调用栈里同步发出：推迟一拍再判断，避免在对方注册途中插队。
    setTimeout(evaluate, 0)
  })

  return {
    evaluate,
    dispose() {
      offRegistry?.()
      release()
    }
  }
}
