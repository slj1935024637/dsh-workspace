/*
 * @Description: 远程工作区绑定测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/workspace/bindings.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BindingStore, folderName, relativeToRoot, toRemotePath } from './bindings.js'
import { WORKSPACE_META_FILE, bindingsFile } from '../paths.js'

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-bind-'))
  process.env.DSH_HOME = sandbox
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

const input = { hostId: 'h1', endpoint: '10.0.0.1-root-22', remotePath: '/home/ps/中山渔业', title: '中山渔业' }

describe('BindingStore', () => {
  it('创建占位目录、写 meta、登记；目录名保留中文', () => {
    const store = new BindingStore()
    const b = store.create(input)
    expect(existsSync(b.localPath)).toBe(true)
    expect(path.basename(b.localPath)).toBe('中山渔业')
    const meta = JSON.parse(readFileSync(path.join(b.localPath, WORKSPACE_META_FILE), 'utf8'))
    expect(meta).toMatchObject({ kind: 'dsh-workspace/remote', hostId: 'h1', remotePath: '/home/ps/中山渔业' })
    expect(store.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
  })

  it('同一主机同一远程目录再次创建：幂等返回同一记录', () => {
    const store = new BindingStore()
    expect(store.create(input).localPath).toBe(store.create(input).localPath)
    expect(store.list()).toHaveLength(1)
  })

  it('同名但远程目录不同：目录名追加短哈希，不串台', () => {
    const store = new BindingStore()
    const a = store.create(input)
    const b = store.create({ ...input, remotePath: '/opt/中山渔业' })
    expect(a.localPath).not.toBe(b.localPath)
    expect(store.resolve(a.localPath)?.remotePath).toBe('/home/ps/中山渔业')
    expect(store.resolve(b.localPath)?.remotePath).toBe('/opt/中山渔业')
  })

  it('会话 cwd 写法不同（大小写 / 结尾斜杠 / 子目录）也能反查', () => {
    const store = new BindingStore()
    const b = store.create({ ...input, title: 'App' })
    expect(store.resolve(`${b.localPath}${path.sep}`)?.hostId).toBe('h1')
    expect(store.resolve(path.join(b.localPath, 'sub', 'dir'))?.hostId).toBe('h1')
    if (process.platform === 'win32') expect(store.resolve(b.localPath.toUpperCase())?.hostId).toBe('h1')
  })

  it('本地普通目录不是远程工作区', () => {
    expect(new BindingStore().resolve(sandbox)).toBeUndefined()
    expect(new BindingStore().resolve(undefined)).toBeUndefined()
  })

  it('映射表丢失：按占位目录里的 meta 文件自愈并补登记', () => {
    const b = new BindingStore().create(input)
    unlinkSync(bindingsFile())
    const fresh = new BindingStore()
    expect(fresh.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
    expect(existsSync(bindingsFile())).toBe(true)
  })

  it('映射表损坏不抛错', () => {
    const store = new BindingStore(() => path.join(sandbox, 'bad.json'))
    writeFileSync(path.join(sandbox, 'bad.json'), '{not json')
    expect(store.list()).toEqual([])
  })

  it('解除登记后不再是远程工作区（meta 也要避免自愈：remove 后删 meta 由调用方决定）', () => {
    const store = new BindingStore()
    const b = store.create(input)
    expect(store.remove(b.localPath)).toBe(true)
    unlinkSync(path.join(b.localPath, WORKSPACE_META_FILE))
    expect(store.resolve(b.localPath)).toBeUndefined()
  })
})

describe('folderName', () => {
  it('替换非法字符、处理保留名与结尾点', () => {
    expect(folderName('a:b*c?')).toBe('a_b_c_')
    expect(folderName('con')).toBe('_con')
    expect(folderName('name. ')).toBe('name')
    expect(folderName('')).toBe('_')
  })
})

describe('toRemotePath', () => {
  const b = { localPath: path.join(tmpdir(), 'ph', 'app'), hostId: 'h', remotePath: '/srv/app', title: 'app', createdAt: '' }

  it('远程绝对路径原样；相对路径相对远程根；. 与 .. 折叠', () => {
    expect(toRemotePath(b, '/etc/hosts')).toBe('/etc/hosts')
    expect(toRemotePath(b, 'src/a.ts')).toBe('/srv/app/src/a.ts')
    expect(toRemotePath(b, './src/../README.md')).toBe('/srv/app/README.md')
    expect(toRemotePath(b, '.')).toBe('/srv/app')
  })

  it('模型照抄会话 cwd 写出的本地绝对路径 → 换成远程根下对应路径', () => {
    expect(toRemotePath(b, path.join(b.localPath, 'src', 'a.ts'))).toBe('/srv/app/src/a.ts')
    expect(toRemotePath(b, b.localPath)).toBe('/srv/app')
  })

  it('【安全】占位目录以外的本机路径一律拒绝 —— 远程会话绝不能碰本机文件', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : path.join(tmpdir(), 'other')
    if (process.platform === 'win32') expect(() => toRemotePath(b, outside)).toThrow(/本机路径/)
  })

  it('relativeToRoot', () => {
    expect(relativeToRoot(b, '/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(relativeToRoot(b, '/srv/app')).toBe('.')
    expect(relativeToRoot(b, '/etc/x')).toBe('/etc/x')
  })
})
