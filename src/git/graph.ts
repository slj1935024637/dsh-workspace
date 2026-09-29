/*
 * @Description: 提交分叉图布局 —— 给按拓扑顺序排列的提交分配泳道，并算出每行的连线
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/git/graph.ts
 *
 * 经典做法：维护「每条泳道正在等待的提交」数组。
 * 处理一个提交时：它落在第一条等待它的泳道（没有则新开一条）；其余等待它的泳道在这里汇合（合并线）；
 * 然后这条泳道改为等待它的第一个父提交，其他父提交各自找已在等待的泳道或新开泳道（分叉线）。
 */

export interface GraphRow {
  /** 本提交所在泳道。 */
  col: number
  /** 本行结束时（下一行开始前）各泳道等待的提交；null 为空闲泳道。 */
  lanes: Array<string | null>
  /** 本行的连线：从上边缘泳道 from 到下边缘泳道 to（节点所在泳道经过节点）。 */
  edges: Array<{ from: number; to: number; kind: 'pass' | 'merge-in' | 'branch-out' }>
  /** 本行开始时的泳道数（画上半段用）。 */
  topWidth: number
  /** 节点上方有线进入（本泳道此前在等待这个提交）；分支顶端为 false。 */
  incoming: boolean
}

export interface GraphInput {
  hash: string
  parents: string[]
}

/**
 * @param commits 按 --topo-order 排列的提交（分页时把已加载的全部传入，保证泳道连续）
 */
export function layoutGraph(commits: readonly GraphInput[]): GraphRow[] {
  let lanes: Array<string | null> = []
  const rows: GraphRow[] = []
  for (const commit of commits) {
    const top = lanes.slice()
    let col = top.indexOf(commit.hash)
    if (col === -1) {
      // 没有泳道在等它（分支顶端）：占第一条空闲泳道，没有就新开。
      col = top.indexOf(null)
      if (col === -1) col = top.length
    }
    const next = top.slice()
    while (next.length <= col) next.push(null)
    const edges: GraphRow['edges'] = []

    // 其他在等本提交的泳道：在这里汇合后空出来。
    for (let i = 0; i < top.length; i += 1) {
      if (i !== col && top[i] === commit.hash) {
        edges.push({ from: i, to: col, kind: 'merge-in' })
        next[i] = null
      }
    }
    // 未涉及本提交的泳道原样穿过。
    for (let i = 0; i < top.length; i += 1) {
      if (i !== col && top[i] !== null && top[i] !== commit.hash) edges.push({ from: i, to: i, kind: 'pass' })
    }

    const [first, ...others] = commit.parents
    next[col] = first ?? null
    if (first !== undefined) edges.push({ from: col, to: col, kind: 'pass' })
    for (const parent of others) {
      let target = next.indexOf(parent)
      if (target === -1) {
        target = next.indexOf(null)
        if (target === -1) target = next.length
        while (next.length <= target) next.push(null)
        next[target] = parent
      }
      edges.push({ from: col, to: target, kind: 'branch-out' })
    }
    // 去掉尾部空泳道，图不会越来越宽。
    while (next.length > 0 && next[next.length - 1] === null) next.pop()
    rows.push({ col, lanes: next, edges, topWidth: top.length, incoming: top[col] === commit.hash })
    lanes = next
  }
  return rows
}

/** 图的最大宽度（泳道数），用于统一画布宽度。 */
export function graphWidth(rows: readonly GraphRow[]): number {
  let max = 1
  for (const r of rows) max = Math.max(max, r.lanes.length, r.topWidth, r.col + 1)
  return max
}
