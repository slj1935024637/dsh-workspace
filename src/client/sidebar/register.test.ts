/*
 * @Description: 右侧栏注册测试（假注册表）—— 三种类型、文件地址按会话认领、单项失败不连累其他
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/register.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
// 标签正文依赖 xterm / Monaco 等浏览器环境；这里只测注册逻辑，正文用占位组件替代。
vi.mock('./SshTab.js', () => ({ SshTab: () => null }))
vi.mock('./RemoteFilesTab.js', () => ({ RemoteFilesTab: () => null }))
vi.mock('./RemoteFileTab.js', () => ({ RemoteFileTab: () => null }))
vi.mock('./GitTab.js', () => ({ GitTab: () => null }))
import { registerConversationTabs, registerRemoteSidebar } from './register.js'
import { RemoteIndex } from './remote-index.js'
import { DETAIL_MIN_WIDTH, LIST_MIN_WIDTH, clampListWidth, defaultListWidth, isWide } from './Split.js'
import { sessionFileAddress } from './remote-index.js'

const ws = { localPath: 'C:\\ph\\app', hostId: 'h1', remotePath: '/srv/app', title: 'app' }

function fakeCtx(options: { failKind?: string } = {}) {
  const registered: Array<{ id: string; kind: string; patterns?: readonly string[]; canOpen?: (a: string) => boolean; multiple?: boolean; guide?: unknown[] }> = []
  const slots: Array<{ name: string; key: string }> = []
  const effects: Array<() => void> = []
  const tabs = {
    register(def: (typeof registered)[number]) {
      if (def.kind === options.failKind) throw new Error('duplicate kind')
      registered.push(def)
      return () => undefined
    }
  }
  const services: Record<string, unknown> = {
    sidebarRightTabs: tabs,
    sessions: {
      list: {
        getSnapshot: () => ({ byId: { remote: { cwd: 'C:\\ph\\app' }, local: { cwd: 'C:\\DshChat' }, none: {} } }),
        subscribe: () => () => undefined
      }
    }
  }
  const sub = {
    get: (n: string) => services[n],
    effect: (f: () => () => void) => {
      effects.push(f())
    }
  }
  const ctx = {
    get: (n: string) => services[n],
    effect: (f: () => (() => void) | void) => f() ?? (() => undefined),
    inject: (_deps: string[], cb: (s: typeof sub) => void) => {
      cb(sub)
      return () => undefined
    },
    slots: {
      inject: (_name: string, f: () => () => void) => f(),
      register: (o: { name: string; key: string }) => {
        slots.push({ name: o.name, key: o.key })
        return () => undefined
      }
    }
  }
  return { ctx, registered, slots, effects }
}

const api = { call: async (m: string) => (m === 'remoteWorkspaces' ? { workspaces: [ws] } : {}) } as never
const t = ((k: string) => k) as never

describe('registerRemoteSidebar', () => {
  it('注册文件查看器 / 远程文件 / SSH 终端，各带正文与标题插槽', async () => {
    const f = fakeCtx()
    registerRemoteSidebar(f.ctx as never, t, api, () => undefined)
    await new Promise((r) => setTimeout(r, 0))
    expect(f.registered.map((r) => r.kind)).toEqual(['dsh-workspace:remote-file', 'dsh-workspace:remote-files', 'dsh-workspace:git', 'dsh-workspace:ssh'])
    expect(f.registered.find((r) => r.kind === 'dsh-workspace:ssh')?.multiple).toBe(true)
    // 比 better-sidebar 的 'dsh-resource://file/**' 更长：同为 extension 时胜出。
    expect(f.registered[0]?.patterns).toContain('dsh-resource://file/session/**')
    expect(f.slots.filter((s) => s.name === 'sidebar.right.pane.tab').map((s) => s.key)).toHaveLength(4)
  })

  it('canOpen：远程会话里的文件认领，本地会话交还原处理方', async () => {
    const f = fakeCtx()
    registerRemoteSidebar(f.ctx as never, t, api, () => undefined)
    await new Promise((r) => setTimeout(r, 0))
    const canOpen = f.registered[0]?.canOpen as (a: string) => boolean
    expect(canOpen(sessionFileAddress('remote', '/srv/app/calculator/index.html'))).toBe(true)
    expect(canOpen(sessionFileAddress('local', '/srv/app/x'))).toBe(false)
  })

  it('某一类型注册失败（如 kind 冲突）：记日志，其余照常注册', async () => {
    const f = fakeCtx({ failKind: 'dsh-workspace:remote-files' })
    const logs: string[] = []
    registerRemoteSidebar(f.ctx as never, t, api, (m) => logs.push(m))
    await new Promise((r) => setTimeout(r, 0))
    expect(f.registered.map((r) => r.kind)).toEqual(['dsh-workspace:remote-file', 'dsh-workspace:git', 'dsh-workspace:ssh'])
    expect(logs.some((m) => m.includes('side.remoteFiles'))).toBe(true)
  })
})

describe('会话顶部标签（方案 A：跟随当前会话动态注册）', () => {
  it('当前会话有工作区（远程或本地）才注册两个标签；切到没有工作区的会话撤下；切回再注册', async () => {
    let key: string | undefined = 'none'
    const listeners = new Set<() => void>()
    const current = { getSnapshot: () => ({ key }), subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) }
    const live = new Set<string>()
    const ctx = {
      get: (n: string) =>
        n === 'uiSession'
          ? { adapter: { current } }
          : n === 'sessions'
            ? { list: { getSnapshot: () => ({ byId: { remote: { cwd: 'C:\\ph\\app' }, local: { cwd: 'C:\\DshChat' }, none: {} } }), subscribe: () => () => undefined } }
            : undefined,
      slots: {
        inject: (_n: string, f: () => () => void) => f(),
        register: (o: { id: string }) => {
          live.add(o.id)
          return () => live.delete(o.id)
        }
      }
    }
    const index = new RemoteIndex(async () => [ws], () => ctx.get('sessions') as never)
    await index.refresh()
    const off = registerConversationTabs(ctx as never, { t, api, index, openResource: () => undefined }, () => undefined)
    expect([...live]).toEqual([])
    key = 'remote'
    for (const l of listeners) l()
    expect([...live].sort()).toEqual(['dsh-workspace-remote-files', 'dsh-workspace-remote-git'])
    for (const l of listeners) l() // 重复通知不重复注册
    expect(live.size).toBe(2)
    key = 'local'
    for (const l of listeners) l()
    expect(live.size).toBe(2)
    key = 'none'
    for (const l of listeners) l()
    expect(live.size).toBe(0)
    key = 'remote'
    for (const l of listeners) l()
    off()
    expect(live.size).toBe(0)
  })

  it('宿主没有 uiSession：跳过并记日志，不抛错', () => {
    const logs: string[] = []
    const index = new RemoteIndex(async () => [], () => undefined)
    registerConversationTabs({ get: () => undefined } as never, { t, api, index, openResource: () => undefined }, (m) => logs.push(m))
    expect(logs[0]).toMatch(/uiSession/)
  })
})

describe('isWide', () => {
  it('700px 起分栏', () => {
    expect(isWide(699)).toBe(false)
    expect(isWide(700)).toBe(true)
  })
})

describe('分栏列表宽度', () => {
  it('默认 = 容器 40%，限制在 300–520px', () => {
    expect(defaultListWidth(700)).toBe(300)
    expect(defaultListWidth(1000)).toBe(400)
    expect(defaultListWidth(2000)).toBe(520)
  })
  it('不小于最小宽度，且给右侧留出最小内容宽度', () => {
    expect(clampListWidth(100, 1000)).toBe(LIST_MIN_WIDTH)
    expect(clampListWidth(900, 1000)).toBe(1000 - DETAIL_MIN_WIDTH)
    expect(clampListWidth(450, 1000)).toBe(450)
  })
  it('容器太窄、两者冲突时以列表最小宽度为准', () => {
    expect(clampListWidth(500, 500)).toBe(LIST_MIN_WIDTH)
  })
})

describe('会话顶部标签：uiSession 晚于插件就绪', () => {
  it('启动时还没有 uiSession：等服务出现后才挂，出现后按当前会话注册（用户实测：之前只取一次，标签永远不出现）', async () => {
    const key: string | undefined = 'remote'
    const current = { getSnapshot: () => ({ key }), subscribe: () => () => undefined }
    const live = new Set<string>()
    let pending: ((sub: { get(n: string): unknown; effect(f: () => () => void): void }) => void) | undefined
    const disposers: Array<() => void> = []
    const sessions = { list: { getSnapshot: () => ({ byId: { remote: { cwd: 'C:\\ph\\app' } } }), subscribe: () => () => undefined } }
    const ctx = {
      get: (n: string) => (n === 'sessions' ? sessions : undefined),
      inject: (deps: string[], cb: typeof pending) => {
        expect(deps).toEqual(['uiSession'])
        pending = cb
        return () => undefined
      },
      slots: {
        inject: (_n: string, f: () => () => void) => f(),
        register: (o: { id: string }) => {
          live.add(o.id)
          return () => live.delete(o.id)
        }
      }
    }
    const index = new RemoteIndex(async () => [ws], () => sessions as never)
    await index.refresh()
    registerConversationTabs(ctx as never, { t, api, index, openResource: () => undefined }, () => undefined)
    expect(live.size).toBe(0) // 服务还没来
    pending?.({ get: () => ({ adapter: { current } }), effect: (f) => void disposers.push(f()) })
    expect([...live].sort()).toEqual(['dsh-workspace-remote-files', 'dsh-workspace-remote-git'])
    for (const d of disposers) d() // 服务撤下 → 标签一并撤下
    expect(live.size).toBe(0)
  })
})
