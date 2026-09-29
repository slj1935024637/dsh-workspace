/*
 * @Description: 远程 Agent 工具真机测试（SSH 后端 + 全部工具逻辑）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/agent.integration.test.ts
 *
 * 运行：DSHWS_IT=1 DSHWS_DIRECT=host:port:user:password npx vitest run src/agent/agent.integration.test.ts
 * 只在 mktemp -d 出来的 /tmp/dshws-it.* 目录里读写，结束只删该目录。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime, DEFAULT_CONFIG, type WorkspaceRuntime } from '../runtime.js'
import { shellQuote } from '../terminal/ssh-shell.js'
import { SshAgentBackend } from './backend.js'
import { PreimageStore } from './preimages.js'
import { remoteBash, remoteEdit, remoteGlob, remoteGrep, remoteRead, remoteWrite, renderBash, type RemoteToolEnv, type ToolExec } from './remote-tools.js'

const enabled = process.env.DSHWS_IT === '1' && (process.env.DSHWS_DIRECT ?? '') !== ''
const TMP_PATTERN = /^\/tmp\/dshws-it\.[A-Za-z0-9]+$/

describe.runIf(enabled)('远程 Agent 工具真机', () => {
  let sandbox: string
  let rt: WorkspaceRuntime
  let root: string
  let env: RemoteToolEnv
  const intents = new Map<string, unknown>()
  const exec: ToolExec = { agent: { session: { id: 'it-session', header: { cwd: 'C:\\placeholder' } } }, signal: new AbortController().signal }

  beforeAll(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-agent-'))
    process.env.DSH_HOME = sandbox
    rt = createRuntime(DEFAULT_CONFIG, { persistTerminals: false })
    const [host, port, user, ...rest] = (process.env.DSHWS_DIRECT as string).split(':')
    rt.vault.initialize('it-master')
    const hostId = rt.vault.createHost({
      label: 'it',
      hostname: host as string,
      port: Number(port),
      username: user as string,
      groupPath: '',
      jumpHostIds: [],
      auth: { kind: 'password', password: rest.join(':') }
    }).id
    const backend = new SshAgentBackend(rt, hostId)
    const made = await backend.run('mktemp -d /tmp/dshws-it.XXXXXX', { cwd: '/tmp', timeoutMs: 15_000, maxBytes: 4096 })
    root = made.stdout.trim()
    expect(root).toMatch(TMP_PATTERN)
    env = {
      binding: { localPath: path.join(sandbox, 'ph'), hostId, remotePath: root, title: 'it', createdAt: '' },
      backend,
      preimages: new PreimageStore(() => path.join(sandbox, 'pre')),
      caps: { limit: 2000, maxLineLength: 2000, maxBytes: 50 * 1024 },
      observe: () => undefined,
      intent: async (event, target) => intents.get(`${event}|${target.displayPath}`),
      sandboxMode: async () => undefined
    }
  }, 60_000)

  afterAll(async () => {
    if (TMP_PATTERN.test(root)) {
      const b = env.backend
      await b.run(`rm -rf -- ${shellQuote(root)}`, { cwd: '/tmp', timeoutMs: 15_000, maxBytes: 4096 })
      const left = await b.run(`test -e ${shellQuote(root)} && echo exists || echo gone`, { cwd: '/tmp', timeoutMs: 15_000, maxBytes: 4096 })
      expect(left.stdout.trim()).toBe('gone')
    }
    rt.dispose()
    delete process.env.DSH_HOME
    rmSync(sandbox, { recursive: true, force: true })
  }, 60_000)

  it('write 新建（含多级目录与中文）→ read 逐行一致', async () => {
    const w = await remoteWrite(env, { file_path: 'src/深层/app.ts', content: 'const a = 1\n// 中文注释\nexport default a\n' }, exec)
    expect(w.operation).toBe('create')
    const r = await remoteRead(env, { file_path: `${root}/src/深层/app.ts` }, exec)
    expect(r.lines.map((l) => l.text)).toEqual(['const a = 1', '// 中文注释', 'export default a'])
    expect(r.totalLines).toBe(3)
  })

  it('edit：唯一替换，保留 CRLF 与权限位', async () => {
    await remoteBash(env, { command: "printf 'a=1\\r\\nb=2\\r\\n' > crlf.sh && chmod 750 crlf.sh", description: 'Prepare fixture' }, exec)
    await remoteEdit(env, { file_path: 'crlf.sh', old_string: 'b=2', new_string: 'b=3' }, exec)
    const check = await remoteBash(env, { command: "od -c crlf.sh | head -2; stat -c %a crlf.sh", description: 'Inspect file' }, exec)
    expect(check.stdout.text).toContain('b   =   3  \\r  \\n')
    expect(check.stdout.text.trim().endsWith('750')).toBe(true)
  })

  it('write 冲突：读后被外部修改 → 拒绝且远端不变', async () => {
    await remoteWrite(env, { file_path: 'c.txt', content: 'v1' }, exec)
    const seen = await env.backend.stat(`${root}/c.txt`)
    await remoteBash(env, { command: "sleep 1.1; printf theirs > c.txt", description: 'External change' }, exec)
    intents.set(`fs/write-intent|${root}/c.txt`, { kind: 'replaceIfVersion', version: `${seen!.size}:${seen!.mtimeMs}` })
    await expect(remoteWrite(env, { file_path: 'c.txt', content: 'mine' }, exec)).rejects.toThrow(/changed since it was read/)
    expect((await remoteRead(env, { file_path: 'c.txt' }, exec)).lines[0]?.text).toBe('theirs')
    intents.clear()
  })

  it('glob：** 模式、结果相对工作区根、最新修改在前', async () => {
    await remoteBash(env, { command: 'mkdir -p lib/x && touch -d "2001-01-01" lib/old.ts && touch lib/x/new.ts && mkdir -p .git && touch .git/ignored.ts', description: 'Prepare tree' }, exec)
    const v = await remoteGlob(env, { pattern: '**/*.ts' }, exec)
    expect(v.paths[0]).toBe('lib/x/new.ts')
    expect(v.paths).toContain('lib/old.ts')
    expect(v.paths).toContain('src/深层/app.ts')
    expect(v.paths.some((p) => p.startsWith('.git/'))).toBe(false)
    expect((await remoteGlob(env, { pattern: '*.ts', path: 'lib' }, exec)).root).toBe('lib')
  })

  it('grep：行号与 read 一致；include 过滤；无匹配返回空', async () => {
    const g = await remoteGrep(env, { pattern: '中文', include: '*.ts' }, exec)
    expect(g.matches).toEqual([{ path: 'src/深层/app.ts', lineNumber: 2, line: '// 中文注释' }])
    expect((await remoteGrep(env, { pattern: 'no-such-token-xyz' }, exec)).matches).toEqual([])
    expect((await remoteGrep(env, { pattern: '\\d+', include: '*.ts' }, exec)).matches.length).toBeGreaterThan(0)
  })

  it('bash：工作目录、退出码、stderr、超时', async () => {
    const pwd = await remoteBash(env, { command: 'pwd', description: 'Print cwd', workdir: 'src' }, exec)
    expect(pwd.stdout.text.trim()).toBe(`${root}/src`)
    const fail = await remoteBash(env, { command: 'echo out; echo err >&2; exit 7', description: 'Fail on purpose' }, exec)
    expect(renderBash(fail)).toBe('out\n[stderr]\nerr\n[exit code: 7]')
    const slow = await remoteBash(env, { command: 'sleep 5', description: 'Sleep', timeoutMs: 800 }, exec)
    expect(slow.timedOut).toBe(true)
    await expect(remoteBash(env, { command: 'true', description: 'x', workdir: 'nope' }, exec)).resolves.toMatchObject({ exitCode: 1 })
  })

  it('pre-image：会话内第一次改动前的内容被存档', () => {
    const entries = env.preimages.list('it-session')
    const crlf = entries.find((e) => e.path === `${root}/crlf.sh`)
    expect(crlf?.absent).toBe(false)
    expect(env.preimages.read('it-session', crlf!.sha256!)?.toString()).toBe('a=1\r\nb=2\r\n')
    expect(entries.find((e) => e.path === `${root}/src/深层/app.ts`)?.absent).toBe(true)
  })
})
