/*
 * @Description: 虚拟滚动的区间计算与会话标签面板高度计算
 * @Author: YangHeng
 * @Date: 2026-09-30 14:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/virtual-list.test.ts
 */
import { describe, expect, it } from 'vitest'
import { indexAt, visibleRange } from './VirtualList.js'
import { fitHeight } from './fit-height.js'

/** 行高序列 → 前缀和。 */
function offsetsOf(heights: number[]): number[] {
  const out = [0]
  for (const h of heights) out.push((out[out.length - 1] as number) + h)
  return out
}

describe('VirtualList 区间', () => {
  it('二分定位行', () => {
    const o = offsetsOf([28, 26, 26, 28, 26])
    expect(indexAt(o, 0)).toBe(0)
    expect(indexAt(o, 27)).toBe(0)
    expect(indexAt(o, 28)).toBe(1)
    expect(indexAt(o, 80)).toBe(3)
    expect(indexAt(o, 10_000)).toBe(4)
  })

  it('10 万行只渲染可见区附近几十行', () => {
    const o = offsetsOf(new Array(100_000).fill(26))
    const [start, end] = visibleRange(o, 26 * 50_000, 520, 260)
    expect(start).toBe(50_000 - 10)
    expect(end).toBe(50_000 + 20 + 10 + 1)
    expect(end - start).toBeLessThan(50)
  })

  it('空列表与滚到末尾', () => {
    expect(visibleRange([0], 0, 500, 100)).toEqual([0, 0])
    const o = offsetsOf(new Array(10).fill(26))
    expect(visibleRange(o, 1000, 500, 100)).toEqual([9, 10])
  })
})

describe('会话标签面板高度', () => {
  it('可视高度减去上下内容，不小于下限', () => {
    expect(fitHeight(900, 40, 120)).toBe(740)
    expect(fitHeight(300, 200, 100)).toBe(240)
  })
})
