/*
 * @Description: 桌面版预览内联测试 —— 相对资源经远程调用取回后内联进 srcdoc
 * @Author: YangHeng
 * @Date: 2026-09-30 11:40:00
 * @FilePath: /dsh-workspace/src/client/sidebar/inline-preview.test.ts
 */
import { describe, expect, it } from 'vitest'
import { fallbackReader, inlineHtml, isRelativeRef, resolveRef, type InlineFailure } from './inline-preview.js'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

function fakeFs(files: Record<string, string>) {
  const reads: string[] = []
  const read = async (p: string) => {
    reads.push(p)
    return files[p] === undefined ? undefined : b64(files[p] as string)
  }
  return { read, reads }
}

describe('引用解析', () => {
  it('只改写相对引用；/ 开头按工作区根；去掉 query 与 hash', () => {
    expect(isRelativeRef('assets/a.css')).toBe(true)
    expect(isRelativeRef('https://cdn.x/a.js')).toBe(false)
    expect(isRelativeRef('//cdn.x/a.js')).toBe(false)
    expect(isRelativeRef('data:image/png;base64,xx')).toBe(false)
    expect(isRelativeRef('#top')).toBe(false)
    expect(resolveRef('../img/a.png?v=1#x', '/srv/site/css', '/srv/site')).toBe('/srv/site/img/a.png')
    expect(resolveRef('/assets/a.css', '/srv/site/sub', '/srv/site')).toBe('/srv/site/assets/a.css')
    expect(resolveRef('%E4%B8%AD.png', '/srv', '/srv')).toBe('/srv/中.png')
  })
})

describe('inlineHtml', () => {
  it('样式表、脚本、图片、CSS url() 与 @import 都内联；外链与缺失文件保持原样', async () => {
    const { read, reads } = fakeFs({
      '/home/ps/app/assets/style.css': '@import "base.css";\nbody { background: url(../img/bg.png) }',
      '/home/ps/app/assets/base.css': 'h1 { color: red }',
      '/home/ps/app/img/bg.png': 'PNG',
      '/home/ps/app/img/logo.svg': '<svg/>',
      '/home/ps/app/js/main.js': 'console.log("</script>")'
    })
    const html = [
      '<link rel="stylesheet" href="assets/style.css?v=2">',
      '<link rel="stylesheet" href="https://cdn.example/x.css">',
      '<script src="js/main.js" defer></script>',
      '<script src="missing.js"></script>',
      '<img src="img/logo.svg" alt="logo">',
      '<div style="background:url(img/bg.png)"></div>'
    ].join('\n')
    const out = await inlineHtml(html, '/home/ps/app/index.html', '/home/ps/app', read)
    expect(out).toContain('h1 { color: red }')
    expect(out).toContain(`url("data:image/png;base64,${b64('PNG')}")`)
    expect(out).toContain('href="https://cdn.example/x.css"')
    expect(out).toContain('<script defer data-dshws-src="js/main.js">')
    expect(out).toContain('console.log("<\\/script>")')
    expect(out).toContain('<script src="missing.js"></script>')
    expect(out).toContain(`src="data:image/svg+xml;base64,${b64('<svg/>')}"`)
    expect(out).not.toContain('<link rel="stylesheet" href="assets/style.css')
    // 同一资源只取一次
    expect(reads.filter((p) => p === '/home/ps/app/img/bg.png')).toHaveLength(1)
  })
})

describe('fallbackReader', () => {
  const outdated = async () => {
    throw new Error('client api: dshWorkspace/sftpReadData failed: transport failure for /api/dshWorkspace/sftpReadData: HTTP 404')
  }

  it('宿主端旧版本（sftpReadData 404）时，样式表 / 脚本退回按文本读，页面照样有样式', async () => {
    const failures: InlineFailure[] = []
    const texts: Record<string, string> = { '/w/style.css': 'body { color: 红; }', '/w/app.js': 'go()' }
    const reader = fallbackReader(outdated, async (p) => ({ content: texts[p] ?? '', binary: false, truncated: false }), failures)
    const html = await inlineHtml('<link rel="stylesheet" href="style.css"><script src="app.js"></script>', '/w/index.html', '/w', reader)
    expect(html).toContain('body { color: 红; }')
    expect(html).toContain('go()')
    expect(failures).toEqual([])
  })

  it('图片等二进制资源无法退回，记进 failures（界面据此提示）', async () => {
    const failures: InlineFailure[] = []
    const reader = fallbackReader(outdated, async () => ({ content: '', binary: true, truncated: false }), failures)
    const html = await inlineHtml('<img src="a.png">', '/w/index.html', '/w', reader)
    expect(html).toContain('src="a.png"')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.path).toBe('/w/a.png')
    expect(failures[0]?.message).toContain('HTTP 404')
  })
})