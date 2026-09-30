/*
 * @Description: 保险箱自动解锁 —— 在本机记住主密钥（Windows 用 DPAPI 加密保存）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/vault/auto-unlock.ts
 *
 * 为什么存「派生出的密钥」而不是主密码：密钥只能解本保险箱，主密码可能在别处也用过。
 * 为什么用 DPAPI：它把数据绑定到当前 Windows 账号 —— 文件被拷到别的电脑 / 别的账号都解不开，
 * 不需要再引入任何密码或依赖（PowerShell 自带 ProtectedData）。
 * 非 Windows 没有等价的自带能力：退化为只有本人可读（0600）的文件，界面上明确说明。
 */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { renameWithRetry } from '../fs-atomic.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type ProtectScheme = 'dpapi' | 'file'

export interface KeyProtector {
  readonly scheme: ProtectScheme
  protect(data: Buffer): Promise<string>
  unprotect(data: string): Promise<Buffer>
}

/** DPAPI 的附加熵：同一账号下别的程序用 DPAPI 保存的数据不会与这里混用。 */
const ENTROPY = 'dsh-workspace/vault-key/v1'

/**
 * Windows PowerShell 的绝对路径：不依赖 PATH（DSH 被精简过 PATH 的环境启动时找不到 powershell.exe）。
 * SystemRoot 缺失时才退回 PATH 查找。
 */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir
  return root !== undefined && root !== '' ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout.trim())
          return
        }
        const detail = (stderr || error.message).trim()
        // AppLocker / 受限语言模式（ConstrainedLanguage）会禁止 Add-Type，给出能看懂的原因而不是一长串 PowerShell 报错。
        const hint = /Add-Type|language mode|ConstrainedLanguage|无法调用方法|Cannot invoke method/i.test(detail)
          ? '（系统策略限制了 PowerShell，如 AppLocker / 受限语言模式；无法使用 Windows 加密保存密钥，请保持关闭自动解锁）'
          : ''
        reject(new Error(`DPAPI 调用失败${hint}：${detail}`))
      }
    )
    child.stdin?.end(input)
  })
}

/** Windows：CurrentUser 范围的 DPAPI。数据经标准输入传入，不出现在命令行里。 */
export const dpapiProtector: KeyProtector = {
  scheme: 'dpapi',
  protect: (data) =>
    runPowerShell(
      `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
        `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); ` +
        `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))`,
      data.toString('base64')
    ),
  unprotect: async (data) =>
    Buffer.from(
      await runPowerShell(
        `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
          `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); ` +
          `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))`,
        data
      ),
      'base64'
    )
}

/** 非 Windows：不加密，只靠文件权限（0600）。 */
export const fileProtector: KeyProtector = {
  scheme: 'file',
  protect: async (data) => data.toString('base64'),
  unprotect: async (data) => Buffer.from(data, 'base64')
}

export function defaultProtector(): KeyProtector {
  return process.platform === 'win32' ? dpapiProtector : fileProtector
}

interface SavedShape {
  version: 1
  scheme: ProtectScheme
  data: string
}

export class AutoUnlockStore {
  constructor(
    private readonly file: () => string,
    private readonly protector: KeyProtector = defaultProtector()
  ) {}

  get scheme(): ProtectScheme {
    return this.protector.scheme
  }

  enabled(): boolean {
    return existsSync(this.file())
  }

  /** 保存密钥（覆盖旧的）。原子写 + 仅本人可读。 */
  async save(key: Buffer): Promise<void> {
    const shape: SavedShape = { version: 1, scheme: this.protector.scheme, data: await this.protector.protect(key) }
    const file = this.file()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(shape), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      /* Windows 上 chmod 只影响只读位，忽略 */
    }
  }

  /** 取回密钥；没有 / 损坏 / 换了账号解不开时返回 undefined（调用方回到手动解锁）。 */
  async load(): Promise<Buffer | undefined> {
    const file = this.file()
    if (!existsSync(file)) return undefined
    const shape = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedShape>
    if (shape.version !== 1 || typeof shape.data !== 'string') throw new Error('自动解锁文件格式不对')
    if (shape.scheme !== this.protector.scheme) throw new Error(`自动解锁文件由 ${String(shape.scheme)} 方式保存，当前系统无法读取`)
    return await this.protector.unprotect(shape.data)
  }

  clear(): void {
    rmSync(this.file(), { force: true })
  }
}
