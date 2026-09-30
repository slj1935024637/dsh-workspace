/*
 * @Description: 自更新：版本比较、安装包检查、查询回退、安装流程（宿主插件管理器用替身）
 * @Author: YangHeng
 * @Date: 2026-09-30 16:00:00
 * @FilePath: /dsh-workspace/src/update/update.test.ts
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { compareVersions, isNewer, parseVersion } from './semver.js'
import { inspectTarball, PLUGIN_PACKAGE } from './tarball.js'
import { fetchLatest } from './source.js'
import { Updater, type PluginManagerLike } from './updater.js'
import { ConnectionLog } from '../log/connection-log.js'

/** 构造一个最小 ustar 包。 */
function tar(entries: Array<{ name: string; body: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.body, 'utf8')
    const header = Buffer.alloc(512)
    header.write(e.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    let sum = 0
    for (const b of header) sum += b
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function pluginTgz(version: string, extra: Record<string, unknown> = {}): Buffer {
  const pkg = { name: PLUGIN_PACKAGE, version, dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0-rc.1', react: '^18' }, ...extra }
  return gzipSync(tar([{ name: 'package/README.md', body: 'hi' }, { name: 'package/package.json', body: JSON.stringify(pkg) }]))
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dshws-update-'))
}

describe('semver', () => {
  it('预发布低于正式版、高于上一个正式版', () => {
    expect(compareVersions('0.10.2-dev.20260930', '0.10.2')).toBeLessThan(0)
    expect(compareVersions('0.10.2-dev.20260930', '0.10.1')).toBeGreaterThan(0)
    expect(compareVersions('0.10.10', '0.10.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
  })

  it('开发环境版本 dev 不提示更新', () => {
    expect(parseVersion('dev')).toBeUndefined()
    expect(isNewer('9.9.9', 'dev')).toBe(false)
    expect(isNewer('0.10.2', '0.10.1')).toBe(true)
  })
})

describe('inspectTarball', () => {
  it('读出包名、版本与 dsh peer', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'a.tgz')
    const data = pluginTgz('0.11.0')
    writeFileSync(file, data)
    const info = await inspectTarball(file, '0.11.0')
    expect(info.version).toBe('0.11.0')
    expect(info.peers).toEqual({ '@deepseek-ai/dsh-agent': '^0.2.0-rc.1' })
    expect(info.sha256).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('拒绝别的包、版本不符、非 gzip、缺插件声明', async () => {
    const dir = tempDir()
    const write = (name: string, data: Buffer): string => {
      const f = path.join(dir, name)
      writeFileSync(f, data)
      return f
    }
    await expect(inspectTarball(write('b.tgz', pluginTgz('1.0.0', { name: 'other' })))).rejects.toThrow(/不是本插件/)
    await expect(inspectTarball(write('c.tgz', pluginTgz('1.0.0')), '2.0.0')).rejects.toThrow(/版本不符/)
    await expect(inspectTarball(write('d.tgz', Buffer.from('PK\x03\x04 zip')))).rejects.toThrow(/解压失败/)
    await expect(inspectTarball(write('e.tgz', pluginTgz('1.0.0', { dsh: {} })))).rejects.toThrow(/dsh\.bundle/)
  })
})

/** fetch 替身：按 URL 前缀返回响应，未命中的抛网络错误。 */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    for (const [prefix, make] of Object.entries(routes)) if (url.startsWith(prefix)) return make()
    throw new TypeError('fetch failed')
  }) as typeof fetch
}

describe('fetchLatest', () => {
  it('GitHub API 可用时带摘要与说明', async () => {
    const latest = await fetchLatest(fakeFetch({
      'https://api.github.com/': () => Response.json({
        tag_name: 'v0.11.0',
        body: '更新说明',
        html_url: 'https://github.com/x',
        assets: [{ name: 'yh4922-dsh-workspace-0.11.0.tgz', browser_download_url: 'https://github.com/a.tgz', digest: `sha256:${'a'.repeat(64)}` }]
      })
    }))
    expect(latest.source).toBe('github')
    expect(latest.version).toBe('0.11.0')
    expect(latest.downloads[0]).toEqual({ url: 'https://github.com/a.tgz', sha256: 'a'.repeat(64) })
    expect(latest.downloads[1]?.url).toBe('https://registry.npmjs.org/@yh4922/dsh-workspace/-/dsh-workspace-0.11.0.tgz')
  })

  it('GitHub 全部不通时回退 npm 官方源', async () => {
    const latest = await fetchLatest(fakeFetch({
      'https://registry.npmjs.org/': () => Response.json({ version: '0.11.1', dist: { tarball: 'https://registry.npmjs.org/t.tgz', integrity: 'sha512-xx' } })
    }))
    expect(latest.source).toBe('npm')
    expect(latest.downloads).toEqual([{ url: 'https://registry.npmjs.org/t.tgz', integrity: 'sha512-xx' }])
  })

  it('全部失败时汇总每个来源的原因', async () => {
    await expect(fetchLatest(fakeFetch({}))).rejects.toThrow(/GitHub API.*GitHub 发布页.*npm 官方源/)
  })
})

describe('Updater', () => {
  function setup(installResult: Awaited<ReturnType<PluginManagerLike['installBundle']>>, tgz = pluginTgz('0.11.0')) {
    const root = tempDir()
    const pkgFile = path.join(root, 'package.json')
    writeFileSync(pkgFile, JSON.stringify({ name: PLUGIN_PACKAGE, version: '0.10.1' }))
    const specs: string[] = []
    const pm: PluginManagerLike = {
      async installBundle(spec) {
        specs.push(spec)
        // 模拟宿主：安装成功后磁盘上的包版本变了。
        if (installResult.application === 'restart-required') writeFileSync(pkgFile, JSON.stringify({ name: PLUGIN_PACKAGE, version: '0.11.0' }))
        return installResult
      }
    }
    const digest = createHash('sha256').update(tgz).digest('hex')
    const fetchImpl = fakeFetch({
      'https://api.github.com/': () => Response.json({
        tag_name: 'v0.11.0',
        assets: [{ name: 'yh4922-dsh-workspace-0.11.0.tgz', browser_download_url: 'https://github.com/dl.tgz', digest: `sha256:${digest}` }]
      }),
      'https://github.com/dl.tgz': () => new Response(new Uint8Array(tgz))
    })
    const updater = new Updater({ packageFile: pkgFile, dir: path.join(root, 'updates'), log: new ConnectionLog(50), pluginManager: () => pm, fetchImpl })
    return { updater, specs, root }
  }

  async function settle(updater: Updater): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const phase = updater.status().job.phase
      if (phase === 'done' || phase === 'failed') return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('检查 → 下载 → 校验 → 安装，完成后显示待重启版本', async () => {
    const { updater, specs } = setup({ application: 'restart-required' })
    const checked = await updater.check()
    expect(checked.latest?.newer).toBe(true)
    updater.startLatest()
    await settle(updater)
    const status = updater.status()
    expect(status.job.phase).toBe('done')
    expect(status.pending).toBe('0.11.0')
    expect(specs[0]).toMatch(/^file:.*\/yh4922-dsh-workspace-0\.11\.0-\d{14}\.tgz$/)
    expect(specs[0]).not.toContain('\\')
  })

  it('摘要不符时不安装', async () => {
    const { updater, specs } = setup({ application: 'restart-required' })
    await updater.check()
    // 让下载内容与摘要不一致：换掉 fetch 返回的包
    ;(updater as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = fakeFetch({
      'https://github.com/dl.tgz': () => new Response(new Uint8Array(pluginTgz('0.11.0', { description: 'tampered' })))
    })
    updater.startLatest()
    await settle(updater)
    expect(updater.status().job.phase).toBe('failed')
    expect(updater.status().job.message).toMatch(/sha256/)
    expect(specs).toEqual([])
  })

  it('宿主安装失败时带出错误码与诊断', async () => {
    const { updater } = setup({ application: 'failed', error: { code: 'incompatible-version' } })
    await updater.check()
    updater.startLatest()
    await settle(updater)
    expect(updater.status().job).toMatchObject({ phase: 'failed' })
    expect(updater.status().job.message).toMatch(/incompatible-version/)
  })

  it('离线包：先检查返回信息，确认后才安装；已失效的 token 拒绝', async () => {
    const { updater, specs, root } = setup({ application: 'restart-required' })
    mkdirSync(path.join(root, 'updates'), { recursive: true })
    const temp = path.join(root, 'updates', 'upload.part')
    writeFileSync(temp, pluginTgz('0.9.0'))
    const view = await updater.acceptUpload(temp)
    expect(view.relation).toBe('older')
    expect(specs).toEqual([])
    updater.startUpload(view.token)
    await settle(updater)
    expect(specs).toHaveLength(1)
    expect(() => updater.startUpload(view.token)).toThrow(/失效/)
  })

  it('上传的不是本插件：删除临时文件并报错', async () => {
    const { updater, root } = setup({ application: 'restart-required' })
    const dir = path.join(root, 'updates')
    mkdirSync(dir, { recursive: true })
    const temp = path.join(dir, 'upload.part')
    writeFileSync(temp, pluginTgz('1.0.0', { name: 'evil' }))
    await expect(updater.acceptUpload(temp)).rejects.toThrow(/不是本插件/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('已是最新版本时拒绝安装', async () => {
    const { updater } = setup({ application: 'restart-required' })
    ;(updater as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = fakeFetch({
      'https://api.github.com/': () => Response.json({ tag_name: 'v0.10.1', assets: [] })
    })
    await updater.check(true)
    expect(() => updater.startLatest()).toThrow(/已是最新/)
  })
})
