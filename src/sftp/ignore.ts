/*
 * @Description: 忽略规则 —— 内置黑名单 + .gitignore 常用子集，用于文件树淡化与搜索剪枝
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/ignore.ts
 *
 * 只实现 .gitignore 的常用子集，刻意不追求完整语义：
 *   - `name` / `*.log`          无斜杠：匹配任意层级的同名项
 *   - `/build`                  前导斜杠：只匹配规则所在目录下的一级
 *   - `logs/`                   尾斜杠：只匹配目录
 *   - `docs/*.md`               中间含斜杠：相对规则所在目录的路径匹配
 *   - `!keep.log`               取反：后出现的规则覆盖前面的
 *   - `**`                      跨任意层级
 * 不支持的写法（如转义 `\#`）按字面处理。这里的结果只用于「淡化显示」与「搜索跳过」，
 * 不用于任何删除或同步决策，所以近似是安全的。
 */
import path from 'node:path'

/** 默认忽略：依赖目录、构建产物、版本库元数据、缓存。 */
export const DEFAULT_IGNORE: readonly string[] = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.hg/',
  'dist/',
  'build/',
  'target/',
  'vendor/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.cache/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  'coverage/',
  '.idea/',
  '.DS_Store'
]

export interface IgnoreRule {
  /** 原始写法，便于调试与展示。 */
  source: string
  negate: boolean
  dirOnly: boolean
  /** 含斜杠（锚定到规则所在目录）；否则匹配任意层级的基名。 */
  anchored: boolean
  regex: RegExp
}

/** 把 glob 片段转成正则。`**` 跨层级，`*` 与 `?` 不跨斜杠。 */
function globToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 可以匹配零层或多层目录；单独的 `**` 匹配任意内容。
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return out
}

/** 解析规则文本（每行一条；空行与 # 注释跳过）。 */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const source = line
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.replace(/\/+$/, '')
    if (line.startsWith('/')) line = line.slice(1)
    if (line === '') continue
    // 去掉前导斜杠之前就含斜杠，或原本以斜杠开头，都视为锚定。
    const anchored = source.replace(/^!/, '').replace(/\/+$/, '').includes('/')
    rules.push({
      source,
      negate,
      dirOnly,
      anchored,
      regex: new RegExp(`^${globToRegex(line)}$`)
    })
  }
  return rules
}

/**
 * 一组规则的判定器。
 * @param base 规则所在目录（远端绝对路径）；锚定规则相对它匹配。
 */
export class IgnoreMatcher {
  constructor(
    private readonly rules: IgnoreRule[],
    private readonly base: string
  ) {}

  /**
   * 判断某个远端路径是否被忽略。后出现的规则覆盖先出现的（与 git 一致）。
   * 不在 base 之下的路径，锚定规则一律不命中，只看基名规则。
   */
  ignores(remotePath: string, isDir: boolean): boolean {
    const rel = relativeUnder(this.base, remotePath)
    const name = path.posix.basename(remotePath)
    let ignored = false
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue
      const hit = rule.anchored ? rel !== undefined && rule.regex.test(rel) : rule.regex.test(name)
      if (hit) ignored = !rule.negate
    }
    return ignored
  }

  /**
   * 生成 find 的剪枝参数：`( -name a -o -name b -o -path 'base/x' ) -prune -o`。
   * 只取「非取反」规则 —— find 表达不了取反的回补，漏剪只会让搜索慢一点，不会出错。
   * 返回参数数组（未转义），由调用方逐个 shell 转义。
   */
  toFindPrune(): string[] {
    const clauses: string[][] = []
    for (const rule of this.rules) {
      if (rule.negate) continue
      const glob = rule.source.replace(/^\//, '').replace(/\/+$/, '')
      const test = rule.anchored
        ? ['-path', `${this.base.replace(/\/+$/, '')}/${glob.replace(/\*\*\//g, '*/')}`]
        : ['-name', glob]
      clauses.push(rule.dirOnly ? [...test, '-type', 'd'] : test)
    }
    if (clauses.length === 0) return []
    const joined: string[] = []
    clauses.forEach((clause, i) => {
      if (i > 0) joined.push('-o')
      joined.push(...clause)
    })
    return ['(', ...joined, ')', '-prune', '-o']
  }
}

/** 取 child 相对 base 的路径；不在 base 之下返回 undefined。 */
function relativeUnder(base: string, child: string): string | undefined {
  const b = base.replace(/\/+$/, '')
  if (b === '') return child.replace(/^\/+/, '')
  if (child === b) return ''
  return child.startsWith(`${b}/`) ? child.slice(b.length + 1) : undefined
}

/** 合并默认规则、用户自定义规则与 .gitignore 内容（优先级依次升高）。 */
export function buildMatcher(base: string, userRules: readonly string[], gitignore: string | undefined): IgnoreMatcher {
  const text = [...DEFAULT_IGNORE, ...userRules, gitignore ?? ''].join('\n')
  return new IgnoreMatcher(parseIgnore(text), base)
}
