/*
 * @Description: 保险箱存储 —— 主机/分组持久化，敏感字段加密，懒解锁
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/vault/store.ts
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  GroupDefaults,
  GroupRecord,
  GroupView,
  HostAuth,
  HostAuthView,
  HostProxy,
  HostProxyView,
  HostRecord,
  HostView
} from '../types.js'
import { pluginRoot, vaultFile } from '../paths.js'
import {
  checkVerifier,
  deriveKey,
  makeVerifier,
  newSalt,
  open,
  seal,
  type Sealed
} from './crypto.js'

// ------------------------------------------------------------------ 落盘结构

type StoredAuth =
  | { kind: 'password'; password: Sealed }
  | { kind: 'keyPath'; keyPath: string; passphrase?: Sealed }
  | { kind: 'keyContent'; keyContent: Sealed; passphrase?: Sealed }
  | { kind: 'agent' }

type StoredProxy = Omit<HostProxy, 'password'> & { password?: Sealed }

/** 落盘的主机：auth/proxy 中的密钥字段被替换为 Sealed。 */
type StoredHost = Omit<HostRecord, 'auth' | 'proxy'> & {
  auth?: StoredAuth
  proxy?: StoredProxy
}

/**
 * 落盘的分组默认值。
 * 分组同样可以携带凭据（整组共用一把密钥或一个密码），
 * 所以必须和主机一样加密 —— 早期版本这里是明文，是一个安全缺陷。
 */
type StoredDefaults = Omit<GroupDefaults, 'auth' | 'proxy'> & {
  auth?: StoredAuth
  proxy?: StoredProxy
}

interface StoredGroup {
  path: string
  defaults: StoredDefaults
  createdAt: string
  updatedAt: string
}

interface VaultFileShape {
  version: 1
  /** base64 salt；未初始化主密码时为空串。 */
  salt: string
  /** 主密码校验串；未初始化时缺省。 */
  verifier?: Sealed
  hosts: Record<string, StoredHost>
  groups: Record<string, StoredGroup>
}

// ------------------------------------------------------------------ 错误

/** 保险箱锁定时需要凭据的操作抛出的错误码。 */
export const VAULT_LOCKED = 'vault_locked'
/** 尚未设置主密码时写入凭据抛出的错误码。 */
export const VAULT_UNINITIALIZED = 'vault_uninitialized'

export class VaultLockedError extends Error {
  readonly code = VAULT_LOCKED
  constructor() {
    super('保险箱已锁定，请先在「远程工作区」页面输入主密码解锁。')
    this.name = 'VaultLockedError'
  }
}

export class VaultUninitializedError extends Error {
  readonly code = VAULT_UNINITIALIZED
  constructor() {
    super('尚未设置主密码。保存密码或私钥之前，请先设置主密码。')
    this.name = 'VaultUninitializedError'
  }
}

/** updateHost 的补丁。键存在即表示「要改」；auth/proxy 值为 null 表示移除（改为继承分组）。 */
export type HostPatch = Partial<Omit<HostRecord, 'id' | 'createdAt' | 'updatedAt' | 'auth' | 'proxy'>> & {
  auth?: HostAuth | null
  proxy?: HostProxy | null
}

const emptyShape = (): VaultFileShape => ({ version: 1, salt: '', hosts: {}, groups: {} })

/**
 * 主机保险箱。
 *
 * 设计要点：
 * - 懒解锁：首次需要凭据时才要求主密码，不在启动时打断用户。
 * - 解锁后密钥在进程生命周期内常驻，不自动上锁 —— 长会话中途莫名失败比
 *   「多留一会儿内存里的密钥」更糟。
 * - 列表读取不需要解锁，只有触碰凭据才需要。
 */
export class Vault {
  private data: VaultFileShape = emptyShape()
  private key: Buffer | null = null
  private loaded = false

  /** 从磁盘读取。文件不存在视为空保险箱，不报错。 */
  load(): void {
    if (this.loaded) return
    const file = vaultFile()
    if (!existsSync(file)) {
      this.data = emptyShape()
      this.loaded = true
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VaultFileShape>
      this.data = {
        version: 1,
        salt: typeof parsed.salt === 'string' ? parsed.salt : '',
        ...(parsed.verifier !== undefined ? { verifier: parsed.verifier } : {}),
        hosts: parsed.hosts ?? {},
        groups: parsed.groups ?? {}
      }
    } catch (cause) {
      // 保险箱损坏必须显式报错：静默重置等于把用户的主机全删了。
      throw new Error(`dsh-workspace: 保险箱文件解析失败（${file}），请检查或从备份恢复。`, {
        cause
      })
    }
    this.loaded = true
  }

  /** 原子写盘：先写临时文件再 rename，避免写一半断电损坏保险箱。 */
  private persist(): void {
    const file = vaultFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  // ---------------------------------------------------------------- 锁状态

  /** 是否已设置过主密码。 */
  isInitialized(): boolean {
    this.load()
    return this.data.verifier !== undefined && this.data.salt !== ''
  }

  /** 当前是否已解锁。 */
  isUnlocked(): boolean {
    return this.key !== null
  }

  /** 首次设置主密码。已初始化时拒绝，改密码走 changeMasterPassword。 */
  initialize(masterPassword: string): void {
    this.load()
    if (this.isInitialized()) throw new Error('主密码已设置，如需修改请使用「修改主密码」。')
    if (masterPassword.length < 6) throw new Error('主密码至少 6 位。')
    const salt = newSalt()
    const key = deriveKey(masterPassword, salt)
    this.data.salt = salt.toString('base64')
    this.data.verifier = makeVerifier(key)
    this.key = key
    this.persist()
  }

  /** 解锁。密码错误返回 false，不抛错（UI 直接提示即可）。 */
  unlock(masterPassword: string): boolean {
    this.load()
    if (!this.isInitialized()) return false
    const salt = Buffer.from(this.data.salt, 'base64')
    const key = deriveKey(masterPassword, salt)
    if (!checkVerifier(key, this.data.verifier as Sealed)) return false
    this.key = key
    return true
  }

  /** 主动上锁（清空内存中的密钥）。 */
  lock(): void {
    this.key = null
  }

  /** 用已保存的密钥解锁（自动解锁用）。密钥不匹配（例如主密码已改）返回 false。 */
  unlockWithKey(key: Buffer): boolean {
    this.load()
    if (!this.isInitialized() || key.length === 0) return false
    if (!checkVerifier(key, this.data.verifier as Sealed)) return false
    this.key = Buffer.from(key)
    return true
  }

  /** 当前密钥的副本（需已解锁）：开启自动解锁时交给 AutoUnlockStore 加密保存。 */
  exportKey(): Buffer {
    return Buffer.from(this.requireKey())
  }

  /**
   * 修改主密码：用旧密钥把主机与分组的敏感字段全部解出，再用新密钥封回去。
   * 先在内存里完整重建，全部成功才写盘，中途失败保险箱保持原状。
   */
  changeMasterPassword(oldPassword: string, newPassword: string): boolean {
    this.load()
    if (newPassword.length < 6) throw new Error('新主密码至少 6 位。')
    if (!this.unlock(oldPassword)) return false
    const oldKey = this.requireKey()

    const plainHosts = Object.values(this.data.hosts).map((h) => decryptHost(h, oldKey))
    const plainGroups = Object.values(this.data.groups).map((g) => decryptGroup(g, oldKey))

    const salt = newSalt()
    const newKey = deriveKey(newPassword, salt)
    const hosts: Record<string, StoredHost> = {}
    for (const host of plainHosts) hosts[host.id] = encryptHost(host, newKey)
    const groups: Record<string, StoredGroup> = {}
    for (const group of plainGroups) groups[group.path] = encryptGroup(group, newKey)

    this.data = { ...this.data, salt: salt.toString('base64'), verifier: makeVerifier(newKey), hosts, groups }
    this.key = newKey
    this.persist()
    return true
  }

  /** 取密钥；未初始化与已锁定是两种不同的用户处境，错误要分开。 */
  private requireKey(): Buffer {
    if (!this.isInitialized()) throw new VaultUninitializedError()
    if (this.key === null) throw new VaultLockedError()
    return this.key
  }

  // ---------------------------------------------------------------- 主机

  /**
   * 列出所有主机（凭据被抹成空串）。
   * 不需要解锁 —— 主机名和分组不是秘密，锁定时能看列表是刻意设计。
   */
  listHosts(): HostRecord[] {
    this.load()
    return Object.values(this.data.hosts).map(stripHost)
  }

  /** 传给浏览器的视图：只带「是否设置过凭据」的标志，永不含原文。 */
  listHostViews(): HostView[] {
    this.load()
    return Object.values(this.data.hosts).map(viewHost)
  }

  /** 按 id 取主机（不含凭据）。 */
  getHost(id: string): HostRecord | undefined {
    this.load()
    const stored = this.data.hosts[id]
    return stored === undefined ? undefined : stripHost(stored)
  }

  /** 取含凭据的完整主机。需要解锁。 */
  getHostWithSecrets(id: string): HostRecord | undefined {
    this.load()
    const stored = this.data.hosts[id]
    if (stored === undefined) return undefined
    return decryptHost(stored, this.requireKey())
  }

  /** 新增主机。带凭据时需要解锁。 */
  createHost(input: Omit<HostRecord, 'id' | 'createdAt' | 'updatedAt'>): HostRecord {
    this.load()
    const now = new Date().toISOString()
    const record: HostRecord = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    const key = needsKey(record.auth, record.proxy) ? this.requireKey() : null
    this.data.hosts[record.id] = encryptHost(record, key)
    this.persist()
    return stripHost(this.data.hosts[record.id] as StoredHost)
  }

  /**
   * 更新主机。只覆盖补丁里出现的键。
   *
   * - `auth` / `proxy` 键不出现：保持原密文不动，无需解锁（改备注不该要求输主密码）
   * - 值为 `null`：移除该项，改为继承分组默认值
   * - 值为对象：整体替换，需要解锁
   */
  updateHost(id: string, patch: HostPatch): HostRecord {
    this.load()
    const stored = this.data.hosts[id]
    if (stored === undefined) throw new Error(`主机不存在：${id}`)

    const { auth, proxy, ...plain } = patch
    const next: StoredHost = { ...stored, ...plain, id, updatedAt: new Date().toISOString() }

    if ('auth' in patch) {
      if (auth === null || auth === undefined) delete next.auth
      else next.auth = encryptAuth(auth, hasAuthSecret(auth) ? this.requireKey() : null)
    }
    if ('proxy' in patch) {
      if (proxy === null || proxy === undefined) delete next.proxy
      else next.proxy = encryptProxy(proxy, proxy.password !== undefined ? this.requireKey() : null)
    }

    this.data.hosts[id] = next
    this.persist()
    return stripHost(next)
  }

  /**
   * 删除主机。被其他主机或分组引用为跳板时拒绝 —— 静默删除会让依赖方
   * 在下次连接时才以一个费解的错误爆掉。
   */
  deleteHost(id: string): void {
    this.load()
    const hostRefs = Object.values(this.data.hosts)
      .filter((h) => h.id !== id && h.jumpHostIds.includes(id))
      .map((h) => `主机「${h.label}」`)
    const groupRefs = Object.values(this.data.groups)
      .filter((g) => g.defaults.jumpHostIds?.includes(id) === true)
      .map((g) => `分组「${g.path}」`)
    const refs = [...hostRefs, ...groupRefs]
    if (refs.length > 0) {
      throw new Error(`该主机被用作跳板机，无法删除。引用方：${refs.join('、')}`)
    }
    delete this.data.hosts[id]
    this.persist()
  }

  // ---------------------------------------------------------------- 分组

  /** 列出分组（凭据被抹成空串），用于继承计算的结构部分。 */
  listGroups(): GroupRecord[] {
    this.load()
    return Object.values(this.data.groups).map(stripGroup)
  }

  /** 列出含凭据的分组，连接解析时使用。需要解锁（仅当分组确实带凭据时）。 */
  listGroupsWithSecrets(): GroupRecord[] {
    this.load()
    const groups = Object.values(this.data.groups)
    if (!groups.some((g) => storedHasSecret(g.defaults.auth, g.defaults.proxy))) {
      return groups.map(stripGroup)
    }
    const key = this.requireKey()
    return groups.map((g) => decryptGroup(g, key))
  }

  listGroupViews(): GroupView[] {
    this.load()
    return Object.values(this.data.groups).map(viewGroup)
  }

  /**
   * 新建或更新分组。
   * 与 updateHost 相同的补丁语义：defaults 中 auth/proxy 键不出现则保留原密文。
   */
  upsertGroup(
    groupPath: string,
    defaults: Omit<GroupDefaults, 'auth' | 'proxy'> & {
      auth?: HostAuth | null
      proxy?: HostProxy | null
    }
  ): GroupRecord {
    this.load()
    const normalized = normalizeGroupPath(groupPath)
    if (normalized === '') throw new Error('分组路径不能为空。')

    const now = new Date().toISOString()
    const existing = this.data.groups[normalized]
    const { auth, proxy, ...plain } = defaults
    const nextDefaults: StoredDefaults = { ...plain }

    if ('auth' in defaults) {
      if (auth !== null && auth !== undefined) {
        nextDefaults.auth = encryptAuth(auth, hasAuthSecret(auth) ? this.requireKey() : null)
      }
    } else if (existing?.defaults.auth !== undefined) {
      nextDefaults.auth = existing.defaults.auth
    }
    if ('proxy' in defaults) {
      if (proxy !== null && proxy !== undefined) {
        nextDefaults.proxy = encryptProxy(proxy, proxy.password !== undefined ? this.requireKey() : null)
      }
    } else if (existing?.defaults.proxy !== undefined) {
      nextDefaults.proxy = existing.defaults.proxy
    }

    const record: StoredGroup = {
      path: normalized,
      defaults: nextDefaults,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.data.groups[normalized] = record
    this.persist()
    return stripGroup(record)
  }

  /**
   * 重命名分组：分组记录（含全部子分组）与其下主机的归属一并迁移，密文原样搬走。
   *
   * 不能用「新建 + deleteGroup(旧)」拼出来：deleteGroup 会连带删除子分组，
   * 而且把 `prod` 改名为 `prod/web` 时，删旧路径会顺手删掉刚建好的新分组。
   */
  renameGroup(from: string, to: string): void {
    this.load()
    const source = normalizeGroupPath(from)
    const target = normalizeGroupPath(to)
    if (source === '' || target === '') throw new Error('分组路径不能为空。')
    if (source === target) return
    if (target.startsWith(`${source}/`)) {
      throw new Error(`不能把分组「${source}」移动到它自己的子路径「${target}」下。`)
    }
    if (this.data.groups[target] !== undefined) {
      throw new Error(`分组「${target}」已存在。`)
    }

    const moved: Record<string, StoredGroup> = {}
    for (const [key, group] of Object.entries(this.data.groups)) {
      if (key === source || key.startsWith(`${source}/`)) {
        const nextPath = target + key.slice(source.length)
        moved[nextPath] = { ...group, path: nextPath, updatedAt: new Date().toISOString() }
        delete this.data.groups[key]
      }
    }
    Object.assign(this.data.groups, moved)

    for (const host of Object.values(this.data.hosts)) {
      if (host.groupPath === source || host.groupPath.startsWith(`${source}/`)) {
        host.groupPath = target + host.groupPath.slice(source.length)
      }
    }
    this.persist()
  }

  /** 删除分组。其下主机与子分组的主机移到根，不级联删除主机。 */
  deleteGroup(groupPath: string): void {
    this.load()
    const normalized = normalizeGroupPath(groupPath)
    for (const key of Object.keys(this.data.groups)) {
      if (key === normalized || key.startsWith(`${normalized}/`)) delete this.data.groups[key]
    }
    for (const host of Object.values(this.data.hosts)) {
      if (host.groupPath === normalized || host.groupPath.startsWith(`${normalized}/`)) {
        host.groupPath = ''
      }
    }
    this.persist()
  }

  // ---------------------------------------------------------------- 备份

  /**
   * 明文导出。忘记主密码 = 主机库报废，所以必须提供备份出口。
   * 需要解锁；导出内容包含全部凭据，调用方负责提醒用户妥善保存。
   */
  exportPlain(): { hosts: HostRecord[]; groups: GroupRecord[] } {
    this.load()
    const key = this.requireKey()
    return {
      hosts: Object.values(this.data.hosts).map((h) => decryptHost(h, key)),
      groups: Object.values(this.data.groups).map((g) => decryptGroup(g, key))
    }
  }

  /** 从明文备份导入。同 id / 同路径覆盖。需要解锁。 */
  importPlain(payload: { hosts?: HostRecord[]; groups?: GroupRecord[] }): { hosts: number; groups: number } {
    this.load()
    const key = this.requireKey()
    let hosts = 0
    let groups = 0
    for (const host of payload.hosts ?? []) {
      this.data.hosts[host.id] = encryptHost(host, key)
      hosts += 1
    }
    for (const group of payload.groups ?? []) {
      this.data.groups[normalizeGroupPath(group.path)] = encryptGroup(group, key)
      groups += 1
    }
    this.persist()
    return { hosts, groups }
  }
}

// ------------------------------------------------------------------ 纯函数

/** 规范化分组路径：去首尾斜杠、合并连续斜杠、去每段首尾空白。 */
export function normalizeGroupPath(input: string): string {
  return input
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('/')
}

function hasAuthSecret(auth: HostAuth | undefined): boolean {
  if (auth === undefined) return false
  switch (auth.kind) {
    case 'password':
    case 'keyContent':
      return true
    case 'keyPath':
      return auth.passphrase !== undefined
    case 'agent':
      return false
  }
}

function needsKey(auth: HostAuth | undefined, proxy: HostProxy | undefined): boolean {
  return hasAuthSecret(auth) || proxy?.password !== undefined
}

function storedHasSecret(auth: StoredAuth | undefined, proxy: StoredProxy | undefined): boolean {
  if (proxy?.password !== undefined) return true
  if (auth === undefined) return false
  switch (auth.kind) {
    case 'password':
    case 'keyContent':
      return true
    case 'keyPath':
      return auth.passphrase !== undefined
    case 'agent':
      return false
  }
}

function sealWith(key: Buffer | null, plaintext: string): Sealed {
  if (key === null) throw new VaultLockedError()
  return seal(key, plaintext)
}

function encryptAuth(auth: HostAuth, key: Buffer | null): StoredAuth {
  switch (auth.kind) {
    case 'password':
      return { kind: 'password', password: sealWith(key, auth.password) }
    case 'keyPath':
      return {
        kind: 'keyPath',
        keyPath: auth.keyPath,
        ...(auth.passphrase !== undefined ? { passphrase: sealWith(key, auth.passphrase) } : {})
      }
    case 'keyContent':
      return {
        kind: 'keyContent',
        keyContent: sealWith(key, auth.keyContent),
        ...(auth.passphrase !== undefined ? { passphrase: sealWith(key, auth.passphrase) } : {})
      }
    case 'agent':
      return { kind: 'agent' }
  }
}

function decryptAuth(stored: StoredAuth, key: Buffer): HostAuth {
  switch (stored.kind) {
    case 'password':
      return { kind: 'password', password: open(key, stored.password) }
    case 'keyPath':
      return {
        kind: 'keyPath',
        keyPath: stored.keyPath,
        ...(stored.passphrase !== undefined ? { passphrase: open(key, stored.passphrase) } : {})
      }
    case 'keyContent':
      return {
        kind: 'keyContent',
        keyContent: open(key, stored.keyContent),
        ...(stored.passphrase !== undefined ? { passphrase: open(key, stored.passphrase) } : {})
      }
    case 'agent':
      return { kind: 'agent' }
  }
}

/** 保留认证方式与路径等非敏感信息，抹掉密钥内容。 */
function blankAuth(stored: StoredAuth): HostAuth {
  switch (stored.kind) {
    case 'password':
      return { kind: 'password', password: '' }
    case 'keyPath':
      return { kind: 'keyPath', keyPath: stored.keyPath }
    case 'keyContent':
      return { kind: 'keyContent', keyContent: '' }
    case 'agent':
      return { kind: 'agent' }
  }
}

function viewAuth(stored: StoredAuth | undefined): HostAuthView | null {
  if (stored === undefined) return null
  switch (stored.kind) {
    case 'password':
      return { kind: 'password', hasSecret: true, hasPassphrase: false }
    case 'keyPath':
      return {
        kind: 'keyPath',
        keyPath: stored.keyPath,
        hasSecret: false,
        hasPassphrase: stored.passphrase !== undefined
      }
    case 'keyContent':
      return { kind: 'keyContent', hasSecret: true, hasPassphrase: stored.passphrase !== undefined }
    case 'agent':
      return { kind: 'agent', hasSecret: false, hasPassphrase: false }
  }
}

function encryptProxy(proxy: HostProxy, key: Buffer | null): StoredProxy {
  const { password, ...rest } = proxy
  return { ...rest, ...(password !== undefined ? { password: sealWith(key, password) } : {}) }
}

function decryptProxy(stored: StoredProxy, key: Buffer): HostProxy {
  const { password, ...rest } = stored
  return { ...rest, ...(password !== undefined ? { password: open(key, password) } : {}) }
}

function blankProxy(stored: StoredProxy): HostProxy {
  const { password, ...rest } = stored
  void password
  return { ...rest }
}

function viewProxy(stored: StoredProxy | undefined): HostProxyView | null {
  if (stored === undefined) return null
  return {
    kind: stored.kind,
    host: stored.host,
    port: stored.port,
    ...(stored.username !== undefined ? { username: stored.username } : {}),
    hasPassword: stored.password !== undefined
  }
}

function encryptHost(record: HostRecord, key: Buffer | null): StoredHost {
  const { auth, proxy, ...rest } = record
  return {
    ...rest,
    ...(auth !== undefined ? { auth: encryptAuth(auth, key) } : {}),
    ...(proxy !== undefined ? { proxy: encryptProxy(proxy, key) } : {})
  }
}

function decryptHost(stored: StoredHost, key: Buffer): HostRecord {
  const { auth, proxy, ...rest } = stored
  return {
    ...rest,
    ...(auth !== undefined ? { auth: decryptAuth(auth, key) } : {}),
    ...(proxy !== undefined ? { proxy: decryptProxy(proxy, key) } : {})
  }
}

function stripHost(stored: StoredHost): HostRecord {
  const { auth, proxy, ...rest } = stored
  return {
    ...rest,
    ...(auth !== undefined ? { auth: blankAuth(auth) } : {}),
    ...(proxy !== undefined ? { proxy: blankProxy(proxy) } : {})
  }
}

function viewHost(stored: StoredHost): HostView {
  const { auth, proxy, ...rest } = stored
  return { ...rest, auth: viewAuth(auth), proxy: viewProxy(proxy) }
}

function encryptGroup(group: GroupRecord, key: Buffer | null): StoredGroup {
  const { auth, proxy, ...rest } = group.defaults
  return {
    ...group,
    defaults: {
      ...rest,
      ...(auth !== undefined ? { auth: encryptAuth(auth, key) } : {}),
      ...(proxy !== undefined ? { proxy: encryptProxy(proxy, key) } : {})
    }
  }
}

function decryptGroup(stored: StoredGroup, key: Buffer): GroupRecord {
  const { auth, proxy, ...rest } = stored.defaults
  return {
    ...stored,
    defaults: {
      ...rest,
      ...(auth !== undefined ? { auth: decryptAuth(auth, key) } : {}),
      ...(proxy !== undefined ? { proxy: decryptProxy(proxy, key) } : {})
    }
  }
}

function stripGroup(stored: StoredGroup): GroupRecord {
  const { auth, proxy, ...rest } = stored.defaults
  return {
    ...stored,
    defaults: {
      ...rest,
      ...(auth !== undefined ? { auth: blankAuth(auth) } : {}),
      ...(proxy !== undefined ? { proxy: blankProxy(proxy) } : {})
    }
  }
}

function viewGroup(stored: StoredGroup): GroupView {
  const { auth, proxy, ...rest } = stored.defaults
  return { ...stored, defaults: { ...rest, auth: viewAuth(auth), proxy: viewProxy(proxy) } }
}

/** 确保插件数据目录存在。 */
export function ensurePluginRoot(): void {
  mkdirSync(pluginRoot(), { recursive: true })
}
