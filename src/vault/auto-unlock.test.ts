/*
 * @Description: 自动解锁测试 —— 真实 DPAPI（Windows）、保存 / 读取、经网关的完整流程
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/vault/auto-unlock.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AutoUnlockStore, dpapiProtector, fileProtector } from './auto-unlock.js'
import { createRuntime, DEFAULT_CONFIG } from '../runtime.js'
import { WorkspaceGateway } from '../gateway.js'
import { autoUnlockFile } from '../paths.js'

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-au-'))
  process.env.DSH_HOME = sandbox
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('Windows DPAPI（真实调用）', () => {
  it('加密后能解回原文；密文里不含原文', async () => {
    const key = randomBytes(32)
    const sealed = await dpapiProtector.protect(key)
    expect(Buffer.from(sealed, 'base64').includes(key)).toBe(false)
    expect((await dpapiProtector.unprotect(sealed)).equals(key)).toBe(true)
  }, 30_000)

  it('篡改后的密文解不开（不会返回错误的密钥）', async () => {
    const sealed = Buffer.from(await dpapiProtector.protect(randomBytes(32)), 'base64')
    const at = sealed.length - 5
    sealed.writeUInt8(sealed.readUInt8(at) ^ 0xff, at)
    await expect(dpapiProtector.unprotect(sealed.toString('base64'))).rejects.toThrow()
  }, 30_000)
})

describe('AutoUnlockStore', () => {
  it('保存 / 读取 / 关闭', async () => {
    const store = new AutoUnlockStore(() => path.join(sandbox, 'k'), fileProtector)
    expect(store.enabled()).toBe(false)
    const key = randomBytes(32)
    await store.save(key)
    expect(store.enabled()).toBe(true)
    expect((await store.load())?.equals(key)).toBe(true)
    store.clear()
    expect(store.enabled()).toBe(false)
    expect(await store.load()).toBeUndefined()
  })

  it('保存方式与当前系统不符（例如从别的系统拷来）→ 明确报错，不误用', async () => {
    writeFileSync(path.join(sandbox, 'k'), JSON.stringify({ version: 1, scheme: 'dpapi', data: 'xx' }))
    const store = new AutoUnlockStore(() => path.join(sandbox, 'k'), fileProtector)
    await expect(store.load()).rejects.toThrow(/dpapi/)
  })
})

describe('经网关的完整流程（重启 = 新建运行时）', () => {
  const boot = () => {
    const rt = createRuntime(DEFAULT_CONFIG, { persistTerminals: false, keyProtector: fileProtector })
    return { rt, gw: new WorkspaceGateway(new Context(), rt) }
  }

  it('开启 → 重启后自动解锁；改主密码 → 仍能自动解锁；关闭 → 重启后需手动解锁', async () => {
    let { rt, gw } = boot()
    await gw.initVault({ password: 'master-pw' })
    expect((await gw.state({})).autoUnlock).toEqual({ enabled: false, scheme: 'file' })

    // 主密码错误不开启
    expect(await gw.setAutoUnlock({ enabled: true, password: 'wrong-pw' })).toEqual({ ok: false, enabled: false })
    expect(existsSync(autoUnlockFile())).toBe(false)

    expect(await gw.setAutoUnlock({ enabled: true, password: 'master-pw' })).toEqual({ ok: true, enabled: true })
    // 保存的是派生密钥，不是主密码
    expect(readFileSync(autoUnlockFile(), 'utf8')).not.toContain('master-pw')
    rt.dispose()

    ;({ rt, gw } = boot())
    expect((await gw.state({})).unlocked).toBe(true)

    await gw.changePassword({ oldPassword: 'master-pw', newPassword: 'new-master-pw' })
    rt.dispose()
    ;({ rt, gw } = boot())
    expect((await gw.state({})).unlocked).toBe(true)

    await gw.setAutoUnlock({ enabled: false })
    expect(existsSync(autoUnlockFile())).toBe(false)
    rt.dispose()
    ;({ rt, gw } = boot())
    const s = await gw.state({})
    expect(s.unlocked).toBe(false)
    expect(s.autoUnlock.enabled).toBe(false)
    rt.dispose()
  })

  it('保存的密钥与主密码不匹配（例如在别处改过主密码）→ 不解锁、记日志，不影响手动解锁', async () => {
    let { rt, gw } = boot()
    await gw.initVault({ password: 'master-pw' })
    await gw.setAutoUnlock({ enabled: true, password: 'master-pw' })
    rt.dispose()
    writeFileSync(autoUnlockFile(), JSON.stringify({ version: 1, scheme: 'file', data: randomBytes(32).toString('base64') }))
    ;({ rt, gw } = boot())
    expect((await gw.state({})).unlocked).toBe(false)
    expect(rt.log.list().some((e) => /自动解锁失败/.test(e.message))).toBe(true)
    expect((await gw.unlock({ password: 'master-pw' })).ok).toBe(true)
    rt.dispose()
  })
})
