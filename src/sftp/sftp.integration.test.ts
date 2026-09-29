/*
 * @Description: SFTP 文件操作真机集成测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/sftp.integration.test.ts
 *
 * 默认跳过；DSHWS_IT=1 且设置 DSHWS_DIRECT=host:port:user:password 时运行。
 * 远端约束：全部读写只发生在 mktemp -d /tmp/dshws-it.XXXXXX 自建目录内，
 * 删除保护测试只校验「拒绝」，在任何实际动作之前就返回。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRuntime, DEFAULT_CONFIG, type WorkspaceRuntime } from '../runtime.js'
import { shellQuote } from '../terminal/ssh-shell.js'
import { execCapture } from './exec.js'
import { RemoteConflictError, RemoteExistsError } from './remote-fs.js'

const enabled = process.env.DSHWS_IT === '1' && (process.env.DSHWS_DIRECT ?? '') !== ''
const TMP_PATTERN = /^\/tmp\/dshws-it\.[A-Za-z0-9]+$/

describe.runIf(enabled)('SFTP 真机', () => {
  let sandbox: string
  let rt: WorkspaceRuntime
  let hostId: string
  let root: string

  /** 在远端执行一条命令（仅用于准备夹具与收尾清理）。 */
  const sh = async (command: string): Promise<string> => {
    const conn = await rt.pool.acquire(hostId, 'file', () => rt.resolveHost(hostId))
    return (await execCapture(conn, command, { timeoutMs: 15_000, maxBytes: 1 << 20 })).stdout
  }

  beforeAll(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-sftp-'))
    process.env.DSH_HOME = sandbox
    rt = createRuntime(DEFAULT_CONFIG, { persistTerminals: false })
    const [host, port, user, ...rest] = (process.env.DSHWS_DIRECT as string).split(':')
    rt.vault.initialize('it-master')
    hostId = rt.vault.createHost({
      label: 'it',
      hostname: host as string,
      port: Number(port),
      username: user as string,
      groupPath: '',
      jumpHostIds: [],
      auth: { kind: 'password', password: rest.join(':') }
    }).id
    root = (await sh('mktemp -d /tmp/dshws-it.XXXXXX')).trim()
    expect(root).toMatch(TMP_PATTERN)
  }, 30_000)

  afterAll(async () => {
    // 只删 mktemp 出来、且通过格式校验的那一个目录。
    if (TMP_PATTERN.test(root)) {
      await sh(`rm -rf -- ${shellQuote(root)}`)
      const left = (await sh(`test -e ${shellQuote(root)} && echo exists || echo gone`)).trim()
      expect(left).toBe('gone')
    }
    rt.dispose()
    delete process.env.DSH_HOME
    rmSync(sandbox, { recursive: true, force: true })
  }, 30_000)

  it('家目录可解析为绝对路径', async () => {
    const home = await rt.files.home(hostId)
    expect(home.startsWith('/')).toBe(true)
  })

  it('新建目录与空文件；独占创建不会覆盖已有文件', async () => {
    const dir = await rt.files.mkdir(hostId, root, 'sub')
    expect(dir).toBe(`${root}/sub`)
    const file = await rt.files.createFile(hostId, dir, '中文.txt')
    expect(file).toBe(`${root}/sub/中文.txt`)
    await expect(rt.files.createFile(hostId, dir, '中文.txt')).rejects.toThrow(/已存在/)
  })

  it('列目录：目录在前、隐藏标记、忽略标记、符号链接目标', async () => {
    await sh(
      [
        `cd ${shellQuote(root)}`,
        'mkdir -p node_modules/pkg z-dir',
        'printf x > b.txt',
        'printf y > .hidden',
        'ln -s z-dir dirlink',
        'ln -s missing-target dangling'
      ].join(' && ')
    )
    const { entries, truncated } = await rt.files.list(hostId, root)
    expect(truncated).toBe(false)
    const names = entries.map((e) => e.name)
    // 目录（含指向目录的链接）排在文件之前
    const firstFile = entries.findIndex((e) => e.type === 'file')
    const lastDir = Math.max(...entries.map((e, i) => (e.type === 'dir' || e.linkIsDir === true ? i : -1)))
    expect(lastDir).toBeLessThan(firstFile)

    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('.hidden')?.hidden).toBe(true)
    expect(byName.get('node_modules')?.ignored).toBe(true)
    expect(byName.get('b.txt')?.ignored).toBe(false)
    expect(byName.get('dirlink')).toMatchObject({ type: 'symlink', linkIsDir: true, linkTarget: 'z-dir' })
    expect(byName.get('dangling')).toMatchObject({ type: 'symlink', linkIsDir: false })
    expect(names).toContain('sub')
  })

  it('.gitignore 被读取并参与忽略标记', async () => {
    await sh(`cd ${shellQuote(root)} && printf '*.secret\\n' > .gitignore && printf s > a.secret`)
    const { entries } = await rt.files.list(hostId, root)
    expect(entries.find((e) => e.name === 'a.secret')?.ignored).toBe(true)
  })

  it('预览：文本原样返回、超限截断、二进制识别', async () => {
    await sh(
      [
        `cd ${shellQuote(root)}`,
        "printf '你好\\nworld\\n' > t.txt",
        'head -c 3000000 /dev/zero | tr "\\0" "a" > big.txt',
        "printf 'a\\000b' > bin.dat"
      ].join(' && ')
    )
    const text = await rt.files.readText(hostId, `${root}/t.txt`, 1024)
    expect(text).toMatchObject({ content: '你好\nworld\n', binary: false, truncated: false })

    const big = await rt.files.readText(hostId, `${root}/big.txt`, 1024 * 1024)
    expect(big.truncated).toBe(true)
    expect(big.size).toBe(3_000_000)
    expect(big.content.length).toBe(1024 * 1024)

    const bin = await rt.files.readText(hostId, `${root}/bin.dat`, 1024)
    expect(bin).toMatchObject({ binary: true, content: '' })

    await expect(rt.files.readText(hostId, root, 1024)).rejects.toThrow(/普通文件/)
  })

  it('重命名：目标已存在时拒绝，不静默覆盖', async () => {
    await sh(`cd ${shellQuote(root)} && printf 1 > r1 && printf 2 > r2`)
    await expect(rt.files.rename(hostId, `${root}/r1`, 'r2')).rejects.toBeInstanceOf(RemoteExistsError)
    expect((await sh(`cat ${shellQuote(`${root}/r2`)}`))).toBe('2')
    expect(await rt.files.rename(hostId, `${root}/r1`, 'r3')).toBe(`${root}/r3`)
  })

  it('上传：写入临时文件后改名；默认不覆盖；覆盖时内容替换；不留临时文件', async () => {
    const payload = Buffer.from('上传内容-'.repeat(20000))
    const up = await rt.files.upload(hostId, root, 'up.bin', Readable.from([payload]), { overwrite: false })
    expect(up.path).toBe(`${root}/up.bin`)
    expect((await sh(`wc -c < ${shellQuote(up.path)}`)).trim()).toBe(String(payload.length))

    await expect(
      rt.files.upload(hostId, root, 'up.bin', Readable.from([Buffer.from('x')]), { overwrite: false })
    ).rejects.toBeInstanceOf(RemoteExistsError)

    await rt.files.upload(hostId, root, 'up.bin', Readable.from([Buffer.from('new')]), { overwrite: true })
    expect(await sh(`cat ${shellQuote(up.path)}`)).toBe('new')

    const leftovers = (await sh(`ls -A ${shellQuote(root)} | grep -c '\\.part$' || true`)).trim()
    expect(leftovers).toBe('0')
  })

  it('上传中途出错：清理临时文件，目标文件不产生', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024, 1))
        this.destroy(new Error('客户端中断'))
      }
    })
    await expect(rt.files.upload(hostId, root, 'broken.bin', failing, { overwrite: false })).rejects.toThrow()
    const listing = await sh(`ls -A ${shellQuote(root)}`)
    expect(listing).not.toContain('broken.bin')
    expect(listing).not.toMatch(/\.part$/m)
  })

  it('下载：内容与大小一致', async () => {
    const { stream, size, name } = await rt.files.openDownload(hostId, `${root}/t.txt`)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(name).toBe('t.txt')
    expect(size).toBe(Buffer.byteLength('你好\nworld\n'))
    expect(Buffer.concat(chunks).toString('utf8')).toBe('你好\nworld\n')
  })

  it('搜索：大小写不敏感，node_modules 被剪枝跳过', async () => {
    await sh(
      [
        `cd ${shellQuote(root)}`,
        'mkdir -p deep/er',
        'printf 1 > deep/er/Needle-One.txt',
        'printf 1 > node_modules/pkg/needle-hidden.txt'
      ].join(' && ')
    )
    const result = await rt.files.search(hostId, root, 'needle')
    const paths = result.matches.map((m) => m.path)
    expect(paths).toContain(`${root}/deep/er/Needle-One.txt`)
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('搜索词里的 glob 元字符按字面匹配', async () => {
    await sh(`cd ${shellQuote(root)} && printf 1 > 'star*name.txt' && printf 1 > starXname.txt`)
    const result = await rt.files.search(hostId, root, 'star*name')
    const names = result.matches.map((m) => path.posix.basename(m.path))
    expect(names).toContain('star*name.txt')
    expect(names).not.toContain('starXname.txt')
  })

  it('【安全】删除目录不跟随其中的符号链接 —— 链接目标里的文件必须完好', async () => {
    await sh(
      [
        `cd ${shellQuote(root)}`,
        'mkdir -p victim to-delete/nested',
        'printf keep > victim/keep.txt',
        // to-delete 里放两个指向 victim 的链接：一个在顶层，一个在子目录里。
        'ln -s ../victim to-delete/link-to-victim',
        'ln -s ../../victim to-delete/nested/deep-link',
        'printf 1 > to-delete/nested/f.txt'
      ].join(' && ')
    )
    const result = await rt.files.remove(hostId, `${root}/to-delete`)
    expect(result).toEqual({ files: 3, dirs: 2 }) // 2 个链接 + 1 个文件；nested 与 to-delete 两个目录

    expect((await sh(`test -e ${shellQuote(`${root}/to-delete`)} && echo exists || echo gone`)).trim()).toBe('gone')
    // 关键断言：链接指向的目录与文件都还在。
    expect(await sh(`cat ${shellQuote(`${root}/victim/keep.txt`)}`)).toBe('keep')
  })

  it('【安全】直接删除一个符号链接只删链接本身', async () => {
    await sh(`cd ${shellQuote(root)} && ln -s victim victim-link`)
    expect(await rt.files.remove(hostId, `${root}/victim-link`)).toEqual({ files: 1, dirs: 0 })
    expect(await sh(`cat ${shellQuote(`${root}/victim/keep.txt`)}`)).toBe('keep')
  })

  it('【安全】拒绝删除根目录、一级目录与家目录（在任何实际动作之前）', async () => {
    await expect(rt.files.remove(hostId, '/')).rejects.toThrow(/根目录或一级目录/)
    await expect(rt.files.remove(hostId, '/tmp')).rejects.toThrow(/根目录或一级目录/)
    await expect(rt.files.remove(hostId, '/tmp/../etc')).rejects.toThrow(/根目录或一级目录/)
    const home = await rt.files.home(hostId)
    await expect(rt.files.remove(hostId, home)).rejects.toThrow(/家目录/)
    // 相对路径与空字符同样被拒
    await expect(rt.files.remove(hostId, 'tmp/x')).rejects.toThrow(/绝对路径/)
  })

  it('非法名称被拒绝（防止借名称穿越目录）', async () => {
    for (const bad of ['../escape', 'a/b', '..', '.', '']) {
      await expect(rt.files.mkdir(hostId, root, bad), bad).rejects.toThrow()
    }
  })

  // ---------------------------------------------------------------- 编辑器保存

  it('保存：内容写入、返回新的修改时间，不留临时文件', async () => {
    const file = `${root}/edit.txt`
    await sh(`printf 'v1\\n' > ${shellQuote(file)}`)
    const opened = await rt.files.readText(hostId, file, 1024)
    const saved = await rt.files.writeText(hostId, file, 'v2 中文\n', opened.mtime)
    expect(await sh(`cat ${shellQuote(file)}`)).toBe('v2 中文\n')
    expect(saved.size).toBe(Buffer.byteLength('v2 中文\n'))
    expect((await sh(`ls -A ${shellQuote(root)} | grep -c '\\.part$' || true`)).trim()).toBe('0')
  })

  it('【冲突】打开后被外部修改 → 拒绝保存，远端内容不变；强制保存才覆盖', async () => {
    const file = `${root}/conflict.txt`
    await sh(`printf 'mine\\n' > ${shellQuote(file)}`)
    const opened = await rt.files.readText(hostId, file, 1024)
    // 模拟终端里被别人改了：内容与修改时间都变（touch 到固定时间，绕开秒级精度）。
    await sh(`printf 'theirs\\n' > ${shellQuote(file)} && touch -d '2001-01-01 00:00:00' ${shellQuote(file)}`)
    await expect(rt.files.writeText(hostId, file, 'overwrite\n', opened.mtime)).rejects.toBeInstanceOf(RemoteConflictError)
    expect(await sh(`cat ${shellQuote(file)}`)).toBe('theirs\n')
    await rt.files.writeText(hostId, file, 'overwrite\n', undefined)
    expect(await sh(`cat ${shellQuote(file)}`)).toBe('overwrite\n')
  })

  it('【冲突】打开后文件被删除 → 视为冲突，不悄悄重建', async () => {
    const file = `${root}/gone.txt`
    await sh(`printf 'x' > ${shellQuote(file)}`)
    const opened = await rt.files.readText(hostId, file, 1024)
    await sh(`rm -f -- ${shellQuote(file)}`)
    await expect(rt.files.writeText(hostId, file, 'y', opened.mtime)).rejects.toBeInstanceOf(RemoteConflictError)
    expect((await sh(`test -e ${shellQuote(file)} && echo exists || echo gone`)).trim()).toBe('gone')
  })

  it('【保真】保存通过符号链接打开的文件：链接仍是链接，改的是目标文件', async () => {
    await sh(`cd ${shellQuote(root)} && printf 'real\\n' > target.conf && ln -s target.conf link.conf`)
    const opened = await rt.files.readText(hostId, `${root}/link.conf`, 1024)
    await rt.files.writeText(hostId, `${root}/link.conf`, 'changed\n', opened.mtime)
    expect((await sh(`test -L ${shellQuote(`${root}/link.conf`)} && echo link || echo notlink`)).trim()).toBe('link')
    expect(await sh(`cat ${shellQuote(`${root}/target.conf`)}`)).toBe('changed\n')
  })

  it('【保真】保存后保留权限位（脚本不会丢掉可执行位）', async () => {
    const file = `${root}/run.sh`
    await sh(`printf '#!/bin/sh\\necho 1\\n' > ${shellQuote(file)} && chmod 750 ${shellQuote(file)}`)
    const opened = await rt.files.readText(hostId, file, 1024)
    await rt.files.writeText(hostId, file, '#!/bin/sh\necho 2\n', opened.mtime)
    expect((await sh(`stat -c %a ${shellQuote(file)}`)).trim()).toBe('750')
  })

  it('非 UTF-8（GBK）文件被标记为有损，前端据此只读', async () => {
    const file = `${root}/gbk.txt`
    await sh(`printf '\\326\\320\\316\\304\\n' > ${shellQuote(file)}`)
    expect((await rt.files.readText(hostId, file, 1024)).lossy).toBe(true)
    expect((await rt.files.readText(hostId, `${root}/edit.txt`, 1024)).lossy).toBe(false)
  })
})
