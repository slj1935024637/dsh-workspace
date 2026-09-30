/*
 * @Description: 接管「文件」侧栏：只在 DSH 自带定义生效时接管；被 better-sidebar 占用时不抢，对方让出后自动接管
 * @Author: YangHeng
 * @Date: 2026-09-30 17:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/files-takeover.test.ts
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_FILES_ID, TAKEOVER_FILES_ID, filesTakeover, manageFilesTakeover, type FilesRegistry } from './files-takeover.js'

/** 按宿主规则的最小注册表：同 kind 一个 builtin + 一个 extension，extension 生效。 */
function registry() {
  const defs: Array<{ id: string; kind: string; band: string }> = []
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const l of listeners) l()
  }
  const reg: FilesRegistry = {
    register(d) {
      const band = d.priority ?? 'extension'
      if (defs.some((x) => x.kind === d.kind && x.band === band)) throw new Error(`kind ${d.kind} already registered (${band})`)
      const entry = { id: d.id, kind: d.kind, band }
      defs.push(entry)
      notify()
      return () => {
        defs.splice(defs.indexOf(entry), 1)
        notify()
      }
    },
    get(kind) {
      const same = defs.filter((d) => d.kind === kind)
      return same.find((d) => d.band === 'extension') ?? same[0]
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  return reg
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('manageFilesTakeover', () => {
  it('DSH 自带生效时接管；关闭开关让出', async () => {
    const tabs = registry()
    tabs.register({ id: BUILTIN_FILES_ID, kind: 'files', priority: 'builtin', title: () => '' })
    let enabled = true
    let mounted = 0
    const m = manageFilesTakeover({ tabs, title: () => 'F', mount: () => (mounted++, () => mounted--), enabled: () => enabled, ready: () => true, log: () => undefined })
    m.evaluate()
    expect(tabs.get?.('files')?.id).toBe(TAKEOVER_FILES_ID)
    expect(filesTakeover.status()).toEqual({ state: 'active' })
    expect(mounted).toBe(1)
    enabled = false
    m.evaluate()
    expect(tabs.get?.('files')?.id).toBe(BUILTIN_FILES_ID)
    expect(filesTakeover.status()).toEqual({ state: 'off' })
    expect(mounted).toBe(0)
    m.dispose()
  })

  it('better-sidebar 已接管时不抢；对方撤下后自动接管', async () => {
    const tabs = registry()
    tabs.register({ id: BUILTIN_FILES_ID, kind: 'files', priority: 'builtin', title: () => '' })
    const offBetter = tabs.register({ id: 'dsh-better-sidebar:files', kind: 'files', priority: 'extension', title: () => '' })
    const m = manageFilesTakeover({ tabs, title: () => 'F', mount: () => () => undefined, enabled: () => true, ready: () => true, log: () => undefined })
    m.evaluate()
    expect(filesTakeover.status()).toEqual({ state: 'blocked', holder: 'dsh-better-sidebar:files' })
    expect(tabs.get?.('files')?.id).toBe('dsh-better-sidebar:files')
    offBetter()
    await tick()
    expect(tabs.get?.('files')?.id).toBe(TAKEOVER_FILES_ID)
    expect(filesTakeover.status()).toEqual({ state: 'active' })
    m.dispose()
    expect(tabs.get?.('files')?.id).toBe(BUILTIN_FILES_ID)
  })

  it('偏好读到之前不做任何判断', () => {
    const tabs = registry()
    tabs.register({ id: BUILTIN_FILES_ID, kind: 'files', priority: 'builtin', title: () => '' })
    const m = manageFilesTakeover({ tabs, title: () => 'F', mount: () => () => undefined, enabled: () => true, ready: () => false, log: () => undefined })
    m.evaluate()
    expect(tabs.get?.('files')?.id).toBe(BUILTIN_FILES_ID)
    m.dispose()
  })
})
