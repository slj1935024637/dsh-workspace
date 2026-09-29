/*
 * @Description: P1 首要风险验证 —— 用 DSH 真实的工具服务确认「作用域同名工具遮蔽全局工具」
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/shadow.test.ts
 *
 * 远程工作区的整个设计建立在这一点上：只给远程会话的 Agent 注册同名 read，
 * 该 Agent 调 read 命中远程实现；其他 Agent（本地会话）仍然命中内置实现。
 * 若这条不成立，Agent 会在远程会话里读到本机文件 —— 所以用真实 ToolRuntime 验证，不用替身。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'

function readTool(label: string) {
  return defineTool({
    name: 'read',
    description: `${label} read`,
    parameters: { file_path: { type: 'string', required: true, description: 'path' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', required: true } } },
      render: (_args: unknown, value: { from: string }) => [{ type: 'text', text: value.from }]
    },
    execute: async () => ({ from: label })
  } as never)
}

async function setup() {
  const ctx = new Context()
  ctx.provide('systemPrompt')
  ctx.set('systemPrompt', { section: () => () => undefined, tools: () => () => undefined, getSectionOrder: () => 0 })
  ctx.plugin(ToolRuntime as never, { mode: 'native', maxParallelSubCalls: 10 } as never)
  await new Promise((r) => setTimeout(r, 50))
  const tools = (ctx as unknown as { tools: ToolRuntime }).tools
  tools.register(readTool('builtin') as never)
  return { ctx, tools }
}

/** 与官方写法一致：在 Agent 作用域里 inject(['tools']) 后注册（DSH 的 dsh-tool-subagent 即如此）。 */
async function registerScoped(scopeCtx: unknown, definition: unknown): Promise<() => void> {
  let registered = false
  const fiber = (scopeCtx as { inject(deps: string[], cb: (c: { tools: ToolRuntime }) => void): { dispose(): void } }).inject(
    ['tools'],
    (c) => {
      c.tools.register(definition as never)
      registered = true
    }
  )
  await new Promise((r) => setTimeout(r, 20))
  if (!registered) throw new Error('作用域注册未生效')
  return () => fiber.dispose()
}

const call = (tools: ToolRuntime, agent: object | undefined) =>
  tools.execute({
    callId: `c-${Math.random()}`,
    name: 'read',
    arguments: { file_path: '/x' },
    signal: new AbortController().signal,
    ...(agent !== undefined ? { agent } : {})
  } as never) as Promise<{ content: Array<{ text?: string }>; isError?: boolean }>

describe('作用域同名工具遮蔽（真实 ToolRuntime）', () => {
  it('远程 Agent 的 read 命中插件实现，本地 Agent 仍命中内置实现', async () => {
    const { ctx, tools } = await setup()
    const remoteAgent = { session: { header: { cwd: '/remote-placeholder' } } }
    const localAgent = { session: { header: { cwd: '/local' } } }
    const remote = createScope(ctx as never, remoteAgent)
    await registerScoped(remote.ctx, readTool('remote'))
    createScope(ctx as never, localAgent)

    expect((await call(tools, remoteAgent)).content[0]?.text).toBe('remote')
    expect((await call(tools, localAgent)).content[0]?.text).toBe('builtin')
    expect((await call(tools, undefined)).content[0]?.text).toBe('builtin')

    // 模型看到的工具清单：远程 Agent 只有一个 read（插件版），没有重名。
    const schemas = tools.schemas(remoteAgent as never).filter((s: { name: string }) => s.name === 'read')
    expect(schemas).toHaveLength(1)
    expect((schemas[0] as { description: string }).description).toBe('remote read')
  })

  it('包装全局定义：只换 execute，参数与渲染与内置完全相同（模型无感的基础）', async () => {
    const { ctx, tools } = await setup()
    const agent = { session: { header: { cwd: '/p' } } }
    const scope = createScope(ctx as never, agent)
    const builtin = tools.get('read') as unknown as Record<string, unknown>
    await registerScoped(scope.ctx, { ...builtin, execute: async () => ({ from: 'remote-via-wrap' }) })
    expect((await call(tools, agent)).content[0]?.text).toBe('remote-via-wrap')
    const local = tools.schemas(undefined).find((s: { name: string }) => s.name === 'read')
    const remote = tools.schemas(agent as never).find((s: { name: string }) => s.name === 'read')
    expect(remote).toEqual(local)
  })

  it('远程作用域释放后，同一 Agent 回落到内置实现', async () => {
    const { ctx, tools } = await setup()
    const agent = { session: { header: { cwd: '/p' } } }
    const scope = createScope(ctx as never, agent)
    const dispose = await registerScoped(scope.ctx, readTool('remote'))
    expect((await call(tools, agent)).content[0]?.text).toBe('remote')
    dispose()
    await new Promise((r) => setTimeout(r, 20))
    expect((await call(tools, agent)).content[0]?.text).toBe('builtin')
  })
})
