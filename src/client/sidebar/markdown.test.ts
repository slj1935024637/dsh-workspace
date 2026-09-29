/*
 * @Description: Markdown 预览页面测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/markdown.test.ts
 */
import { describe, expect, it } from 'vitest'
import { directoryHref, markdownDocument } from './markdown.js'

describe('markdownDocument', () => {
  it('GFM 渲染：标题、表格、任务列表、代码块', () => {
    const html = markdownDocument('# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 完成\n\n```js\nconst a = 1\n```', undefined, false)
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<code class="language-js">')
  })

  it('相对图片经 <base> 指向预览目录；CSP 禁止脚本（Markdown 里夹带的 script 不会执行）', () => {
    const base = directoryHref('/dsh-workspace/preview/tok/home/ps/app/README.md', 'http://127.0.0.1:43120')
    expect(base).toBe('http://127.0.0.1:43120/dsh-workspace/preview/tok/home/ps/app/')
    const html = markdownDocument('![图](./img/a.png)\n\n<script>alert(1)</script>', base, true)
    expect(html).toContain(`<base href="${base}">`)
    expect(html).toContain('<img src="./img/a.png"')
    expect(html).toMatch(/default-src 'none'/)
    expect(html).not.toMatch(/script-src/)
    expect(html).toContain('img-src http://127.0.0.1:43120 data:')
  })
})
