/*
 * @Description: dsh-workspace 浏览器端入口 —— 左侧入口行 + 主区整页
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/index.tsx
 */
import { createApi } from './api.js'
import type { ClientContext, Translate } from './context.js'
import { DICTIONARIES, NS, withVars } from './locale.js'
import { injectStyles } from './styles.js'
import { WorkspacePage } from './page/WorkspacePage.js'
import { AddWorkspaceFlow } from './workspace/AddWorkspaceFlow.js'
import { registerRemoteSidebar } from './sidebar/register.js'
import { onTakeoverChange } from './workspace/takeover.js'

export const name = 'dsh-workspace'

/**
 * 客户端半依赖：slots（注册入口与整页）、locale（双语）、remote（调用宿主）。
 *
 * better-sidebar 刻意不在这里：它是可选的第三方插件，硬依赖会让
 * 「只想连个服务器」的用户被一个无关插件卡住。侧边栏 tab 在 P1 用
 * ctx.get('betterSidebar') 动态探测后再注册。
 */
export const inject = ['slots', 'locale', 'remote']

/** 左侧入口行 id 与主区页面 key，两者必须一致（选中缺失 key 宿主会直接抛错）。 */
const PANEL_ID = 'dsh-workspace'

/**
 * 侧栏排序：宿主「插件」行为 0，技能面板 1，MCP 面板 2。
 * 取 3，紧跟在技能与 MCP 之后 —— 这是需求里指定的位置。
 */
const PANEL_ORDER = 3

/** 侧栏图标：服务器机架。尺寸与颜色跟随宿主行（currentColor）。 */
function PanelIcon(props: { size?: number }) {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
  return (
    <span className="dshws-panel-icon" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2.5" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
        <rect x="2" y="9" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.75" cy="4.75" r="0.85" fill="currentColor" />
        <circle cx="4.75" cy="11.25" r="0.85" fill="currentColor" />
        <path d="M8 4.75h3.5M8 11.25h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-workspace: dictionaries')
  ctx.effect(() => injectStyles(), 'dsh-workspace: styles')

  const raw = ctx.locale.bind(NS)
  const t: Translate = withVars(raw)
  const api = createApi(ctx)

  /** 返回会话视图：layout 由宿主 shell 提供，取不到时箭头是空操作，不影响其余功能。 */
  const backToConversation = (): void => {
    const layout = ctx.get('layout') as { selectPanel?: (id: string | null) => void } | undefined
    layout?.selectPanel?.(null)
  }

  const face = () => ({ t, api, backToConversation })

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => raw('nav'),
        locale: NS
      },
      PanelIcon as never
    )
  )

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: face
      },
      WorkspacePage as never
    )
  )

  // 远程工作区的右侧栏：远程文件查看器 / 远程文件树 / SSH 终端。失败只记控制台，不影响其余功能。
  ctx.effect(() => {
    const log = (message: string, error?: unknown): void => console.warn(`[dsh-workspace] ${message}`, error ?? '')
    try {
      return registerRemoteSidebar(ctx, t, api, log)
    } catch (error) {
      log('右侧栏接入失败', error)
      return undefined
    }
  }, 'dsh-workspace: remote sidebar')

  // 接管「添加工作区」：偏好里关闭时不注册，DSH 原来的选择器自然生效。
  // 取不到偏好（宿主未就绪）时按默认开启处理 —— 本机浏览不依赖本插件的宿主端。
  // 管理页切换开关时即时注册 / 撤下（插槽按 priority 自动让位），不需要刷新页面。
  ctx.effect(() => {
    let active: (() => void) | undefined
    let disposed = false
    const apply = (enabled: boolean): void => {
      if (disposed) return
      if (enabled && active === undefined) active = registerAddWorkspace(ctx, t, api)
      if (!enabled && active !== undefined) {
        active()
        active = undefined
      }
    }
    const off = onTakeoverChange(apply)
    void api
      .call('getPrefs', {})
      .then((prefs) => prefs.takeoverAddWorkspace, () => true)
      .then(apply)
    return () => {
      disposed = true
      off()
      active?.()
      active = undefined
    }
  }, 'dsh-workspace: add-workspace takeover')
}

/**
 * 侧栏的「添加工作区」（含快捷键，桌面 Ctrl+O / 网页 Ctrl+Alt+O）与首页入口是两个插槽，都要占。
 * priority -200：比 dsh-bridge（-10）与已停用的 dsh-remote（-100）都小；同一插槽同 priority 会直接报错，
 * 所以避开它们。组件崩溃时宿主会让位给下一个占用者，不会导致无法添加工作区。
 */
const ADD_WORKSPACE_SLOTS = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']
const ADD_WORKSPACE_PRIORITY = -200

function registerAddWorkspace(ctx: ClientContext, t: Translate, api: ReturnType<typeof createApi>): () => void {
  const inject = () => ({
    t,
    api,
    workspaces: () => ctx.get('workspaces'),
    uiWorkspace: () => ctx.get('uiWorkspace')
  })
  const disposers = ADD_WORKSPACE_SLOTS.map((slot) =>
    ctx.slots.inject(slot, () =>
      ctx.slots.register({ name: slot, priority: ADD_WORKSPACE_PRIORITY, inject }, AddWorkspaceFlow as never)
    )
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
