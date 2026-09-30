/*
 * @Description: 目录浏览错误归类与系统目录识别
 * @Author: YangHeng
 * @Date: 2026-09-30 11:00:00
 * @FilePath: /dsh-workspace/src/client/workspace/browse-error.test.ts
 */
import { describe, expect, it } from 'vitest'
import { classifyBrowseError, isEmptyDirQuirk, isSystemDirName } from './browse-error.js'

describe('isEmptyDirQuirk', () => {
  it('识别 115 挂载盘空文件夹的两种报错', () => {
    expect(isEmptyDirQuirk(new Error('directory browse failed: directory-picker/unreadable: cannot list E:\\共享文档\\乱七八糟: EINVAL: invalid argument, readdir'))).toBe(true)
    expect(isEmptyDirQuirk(new Error("ENOENT: no such file or directory, scandir 'E:\\a'"))).toBe(true)
  })
  it('权限等其他错误不算', () => {
    expect(isEmptyDirQuirk(new Error('directory browse failed: directory-picker/unreadable: cannot list C:\\x: EPERM: operation not permitted, scandir'))).toBe(false)
  })
})

describe('classifyBrowseError', () => {
  it('用户反馈的网盘挂载报错：归为不可读并剥掉宿主前缀', () => {
    const err = new Error('directory browse failed: directory-picker/unreadable: cannot list X:\\System Volume Information: EINVAL: invalid argument, readdir')
    expect(classifyBrowseError(err)).toEqual({ kind: 'unreadable', detail: 'cannot list X:\\System Volume Information: EINVAL: invalid argument, readdir' })
  })

  it('优先使用 rpcError.code', () => {
    const err = Object.assign(new Error('directory browse failed: boom'), { rpcError: { code: 'directory-picker/exists' } })
    expect(classifyBrowseError(err).kind).toBe('exists')
  })

  it('远程 SFTP 权限错误也按不可读提示，其余归 other', () => {
    expect(classifyBrowseError(new Error('EACCES: permission denied, /root')).kind).toBe('unreadable')
    expect(classifyBrowseError(new Error('socket hang up')).kind).toBe('other')
  })
})

describe('isSystemDirName', () => {
  it('识别 Windows 卷根的系统保留目录', () => {
    expect(isSystemDirName('System Volume Information')).toBe(true)
    expect(isSystemDirName('$RECYCLE.BIN')).toBe(true)
    expect(isSystemDirName('Projects')).toBe(false)
  })
})
