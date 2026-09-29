/*
 * @Description: 忽略规则解析与匹配测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/ignore.test.ts
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_IGNORE, IgnoreMatcher, buildMatcher, parseIgnore } from './ignore.js'

const m = (rules: string, base = '/repo') => new IgnoreMatcher(parseIgnore(rules), base)

describe('parseIgnore', () => {
  it('跳过空行与注释', () => {
    expect(parseIgnore('\n# comment\n  \nfoo\n')).toHaveLength(1)
  })

  it('识别取反、仅目录、锚定', () => {
    const [a, b, c, d] = parseIgnore('!keep\nlogs/\n/build\ndocs/*.md')
    expect(a).toMatchObject({ negate: true, dirOnly: false, anchored: false })
    expect(b).toMatchObject({ negate: false, dirOnly: true, anchored: false })
    expect(c).toMatchObject({ anchored: true })
    expect(d).toMatchObject({ anchored: true })
  })
})

describe('IgnoreMatcher', () => {
  it('无斜杠规则匹配任意层级的同名项', () => {
    const matcher = m('*.log')
    expect(matcher.ignores('/repo/a.log', false)).toBe(true)
    expect(matcher.ignores('/repo/deep/x/b.log', false)).toBe(true)
    expect(matcher.ignores('/repo/a.txt', false)).toBe(false)
  })

  it('尾斜杠只匹配目录', () => {
    const matcher = m('logs/')
    expect(matcher.ignores('/repo/logs', true)).toBe(true)
    expect(matcher.ignores('/repo/logs', false)).toBe(false)
  })

  it('前导斜杠只匹配规则所在目录下的一级', () => {
    const matcher = m('/build')
    expect(matcher.ignores('/repo/build', true)).toBe(true)
    expect(matcher.ignores('/repo/sub/build', true)).toBe(false)
  })

  it('中间带斜杠的规则相对 base 匹配', () => {
    const matcher = m('docs/*.md')
    expect(matcher.ignores('/repo/docs/a.md', false)).toBe(true)
    expect(matcher.ignores('/repo/docs/sub/a.md', false)).toBe(false)
    expect(matcher.ignores('/repo/other/docs/a.md', false)).toBe(false)
  })

  it('** 跨任意层级', () => {
    const matcher = m('**/tmp/*.bin')
    expect(matcher.ignores('/repo/tmp/a.bin', false)).toBe(true)
    expect(matcher.ignores('/repo/x/y/tmp/a.bin', false)).toBe(true)
  })

  it('后出现的取反规则覆盖前面的', () => {
    const matcher = m('*.log\n!keep.log')
    expect(matcher.ignores('/repo/a.log', false)).toBe(true)
    expect(matcher.ignores('/repo/keep.log', false)).toBe(false)
  })

  it('正则元字符按字面处理', () => {
    const matcher = m('a+b.(x)')
    expect(matcher.ignores('/repo/a+b.(x)', false)).toBe(true)
    expect(matcher.ignores('/repo/aab.x', false)).toBe(false)
  })

  it('锚定规则不命中 base 之外的路径', () => {
    const matcher = m('/build')
    expect(matcher.ignores('/elsewhere/build', true)).toBe(false)
  })

  it('base 为根目录时同样生效', () => {
    const matcher = m('/build', '/')
    expect(matcher.ignores('/build', true)).toBe(true)
  })
})

describe('默认规则', () => {
  const matcher = buildMatcher('/repo', [], undefined)

  it('依赖目录与版本库元数据被忽略', () => {
    for (const dir of ['node_modules', '.git', 'dist', '__pycache__', '.venv']) {
      expect(matcher.ignores(`/repo/x/${dir}`, true), dir).toBe(true)
    }
  })

  it('同名的普通文件不被忽略（规则是仅目录）', () => {
    expect(matcher.ignores('/repo/dist', false)).toBe(false)
  })

  it('.gitignore 可以取反默认规则', () => {
    const custom = buildMatcher('/repo', [], '!dist/')
    expect(custom.ignores('/repo/dist', true)).toBe(false)
  })

  it('用户规则叠加在默认规则之后', () => {
    const custom = buildMatcher('/repo', ['*.tmp'], undefined)
    expect(custom.ignores('/repo/a.tmp', false)).toBe(true)
    expect(custom.ignores('/repo/node_modules', true)).toBe(true)
  })

  it('默认规则全部可被解析', () => {
    expect(parseIgnore(DEFAULT_IGNORE.join('\n'))).toHaveLength(DEFAULT_IGNORE.length)
  })
})

describe('toFindPrune', () => {
  it('生成合法的 find 剪枝表达式', () => {
    const args = m('node_modules/\n/build\n*.log\n!keep.log').toFindPrune()
    expect(args[0]).toBe('(')
    expect(args.slice(-3)).toEqual([')', '-prune', '-o'])
    expect(args).toContain('node_modules')
    expect(args).toContain('/repo/build')
    // 取反规则无法用 find 表达，被跳过。
    expect(args).not.toContain('keep.log')
  })

  it('没有规则时不生成任何参数', () => {
    expect(m('').toFindPrune()).toEqual([])
  })
})
