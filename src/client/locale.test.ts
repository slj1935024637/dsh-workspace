/*
 * @Description: 文案完整性测试 —— 中英键集一致、源码里用到的每个键都有定义
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/locale.test.ts
 *
 * 缺失的文案键不会报错，页面上只会原样显示键名（如 files.retry），
 * 类型检查与其他测试都发现不了，所以单独守一道。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DICTIONARIES } from './locale.js'

const clientDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.generated.ts')) out.push(full)
  }
  return out
}

/** 源码里以字面量调用的键：t('a.b') / t("a.b")，以及 raw('nav') 这类绑定函数。 */
function usedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of sourceFiles(clientDir)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\b(?:t|raw)\(\s*['"]([A-Za-z][\w.]*)['"]/g)) keys.add(m[1] as string)
  }
  // 模板字符串拼出来的键无法静态提取，在此显式列出。
  for (const section of ['hosts', 'files', 'terminals', 'logs']) keys.add(`section.${section}`)
  return keys
}

describe('文案', () => {
  const zh = Object.keys(DICTIONARIES.zh).sort()
  const en = Object.keys(DICTIONARIES.en).sort()

  it('中英文键集完全一致', () => {
    expect(zh.filter((k) => !en.includes(k)), '只有中文有').toEqual([])
    expect(en.filter((k) => !zh.includes(k)), '只有英文有').toEqual([])
  })

  it('源码中使用的每个键都已定义', () => {
    const used = usedKeys()
    expect(used.size).toBeGreaterThan(50)
    const missing = [...used].filter((k) => !(k in DICTIONARIES.zh)).sort()
    expect(missing).toEqual([])
  })

  it('占位符在中英文里一致（{name} 这类）', () => {
    const mismatched: string[] = []
    for (const key of zh) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
      if (vars(DICTIONARIES.zh[key] as string) !== vars(DICTIONARIES.en[key] as string)) mismatched.push(key)
    }
    expect(mismatched).toEqual([])
  })
})
