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
import { closeBridgeDrawer, holdSlotHead, shieldAddWorkspaceClicks, type SlotsPeek } from './workspace/bridge-compat.js'

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
 * 移动端进入本页时把左侧抽屉收起来。
 * 宿主只在「会话导航」时自动收抽屉，main 插槽的全局面板不会 —— 抽屉会一直盖在内容上。
 * 判据：viewport < 1024（宿主同款断点）且 shell 未标记 [data-sidebar-collapsed]
 * （宿主是收起时才写这个属性，没写就说明抽屉正开着）；layout 服务取不到就静默跳过。
 */
function collapseNarrowDrawer(ctx: ClientContext): void {
  if (typeof window === 'undefined' || window.innerWidth >= 1024) return
  // 装了 dsh-bridge 时，手机上的抽屉容器是它用 body.dsh-drawer-open 控制的覆盖层，宿主 toggleSidebar 不会同步它：
  // 只收宿主会出现「图标收成窄栏、抽屉容器还开着」。两边都要收。
  closeBridgeDrawer()
  if (typeof document !== 'undefined' && document.querySelector('[data-sidebar-collapsed]') !== null) return
  const layout = ctx.get('layout') as { toggleSidebar?: () => void } | undefined
  if (typeof layout?.toggleSidebar !== 'function') return
  layout.toggleSidebar()
}

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

  const face = () => ({ t, api, backToConversation, onEnter: () => collapseNarrowDrawer(ctx) })

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
 * 侧栏的「添加工作区」（含快捷键，桌面 Ctrl+O / 网页 Ctrl+Alt+O）与首页入口是两个 single 插槽，都要占。
 * 宿主对 single 插槽的规则是「priority 数值最小者渲染」（dsh-client-ui-slots：lowest renders），同 priority 直接抛错。
 * ⚠️ 本插件是动态包：运行器会把传入的 priority 改写成页内递减计数，-1000 只在静态加载时才生效，
 * 所以真正保证赢过 dsh-bridge（-10）的是 holdSlotHead 的「不是 head 就重注册」。
 * 公网访问时 dsh-bridge 还会在 document 捕获阶段截走按钮点击，由 shieldAddWorkspaceClicks 中和（见 bridge-compat.ts）。
 * 注册回调里抛错会被宿主吞成微任务异常（表现成「只有接管静默失效」），因此逐个 try/catch。
 */
const ADD_WORKSPACE_SLOTS = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']
const ADD_WORKSPACE_PRIORITY = -1000

function registerAddWorkspace(ctx: ClientContext, t: Translate, api: ReturnType<typeof createApi>): () => void {
  const inject = () => ({
    t,
    api,
    workspaces: () => ctx.get('workspaces'),
    uiWorkspace: () => ctx.get('uiWorkspace'),
    // 手机上从抽屉里点开弹窗时抽屉不会自己收起，会压在弹窗后面。
    // 宿主在窄栏（rail）模式下仍挂着 WorkspacePickFlow，收起抽屉不会卸载弹窗。
    onShown: () => collapseNarrowDrawer(ctx)
  })
  const disposers = ADD_WORKSPACE_SLOTS.map((slot) => {
    try {
      return ctx.slots.inject(slot, () => {
        try {
          return holdSlotHead(
            ctx.slots as unknown as SlotsPeek,
            slot,
            () => ctx.slots.register({ name: slot, priority: ADD_WORKSPACE_PRIORITY, inject }, AddWorkspaceFlow as never),
            AddWorkspaceFlow,
            (message) => console.warn(`[dsh-workspace] ${message}`)
          )
        } catch (error) {
          console.warn(`[dsh-workspace] 接管「添加工作区」失败（${slot}）`, error)
          return () => undefined
        }
      })
    } catch (error) {
      console.warn(`[dsh-workspace] 注入「添加工作区」插槽失败（${slot}）`, error)
      return () => undefined
    }
  })
  const unshield = shieldAddWorkspaceClicks()
  return () => {
    unshield()
    for (const dispose of disposers) dispose()
  }
}
