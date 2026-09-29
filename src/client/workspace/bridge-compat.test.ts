/*
 * @Description: bridge-compat 单测 —— 插槽 head 抢占（模拟宿主运行器改写 priority）
 * @Author: YangHeng
 * @Date: 2026-09-30 10:00:00
 * @FilePath: /dsh-workspace/src/client/workspace/bridge-compat.test.ts
 */
import { describe, expect, it } from 'vitest'
import { holdSlotHead } from './bridge-compat.js'

/** 极简 single 插槽：lowest priority renders；listeners 同步通知。 */
function fakeSlots() {
  let list: Array<{ component: unknown; options: { priority: number } }> = []
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())
  return {
    entries: () => list,
    entriesOfSlot: () => list.slice(0, 1),
    subscribe: (_k: string, fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    add(component: unknown, priority: number) {
      const entry = { component, options: { priority } }
      list = [...list, entry].sort((a, b) => a.options.priority - b.options.priority)
      notify()
      return () => {
        list = list.filter((e) => e !== entry)
        notify()
      }
    }
  }
}

describe('holdSlotHead', () => {
  it('运行器改写 priority 时，重注册直到压过 dsh-bridge 的 -10', () => {
    const slots = fakeSlots()
    const bridge = {}
    const mine = {}
    slots.add(bridge, -10)
    let counter = -3
    const warns: string[] = []
    const off = holdSlotHead(slots, 's', () => slots.add(mine, --counter), mine, (m) => warns.push(m))
    expect(slots.entriesOfSlot()[0]?.component).toBe(mine)
    expect(slots.entries().filter((e) => e.component === mine)).toHaveLength(1)
    expect(warns).toEqual([])
    off()
    expect(slots.entries().some((e) => e.component === mine)).toBe(false)
  })

  it('别人后来压过时重新抢回', () => {
    const slots = fakeSlots()
    const mine = {}
    let counter = 0
    holdSlotHead(slots, 's', () => slots.add(mine, --counter), mine, () => undefined)
    slots.add({}, -50)
    expect(slots.entriesOfSlot()[0]?.component).toBe(mine)
  })

  it('priority 是定值时不空转，只告警一次', () => {
    const slots = fakeSlots()
    const mine = {}
    slots.add({}, -2000)
    let calls = 0
    const warns: string[] = []
    holdSlotHead(
      slots,
      's',
      () => {
        calls++
        return slots.add(mine, -1000)
      },
      mine,
      (m) => warns.push(m)
    )
    expect(calls).toBeLessThanOrEqual(3)
    expect(warns).toHaveLength(1)
  })
})
