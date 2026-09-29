/*
 * @Description: 文件夹浏览器的路径辅助函数测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/workspace/paths.test.ts
 */
import { describe, expect, it } from 'vitest'
import { isWindowsPath, lastSegment, localCrumbs, localParent, remoteCrumbs, remoteParent } from './FolderBrowser.js'

describe('路径辅助', () => {
  it('localParent：Windows 盘符根、深层目录、POSIX', () => {
    expect(localParent('C:\\Users\\me\\proj')).toBe('C:\\Users\\me')
    expect(localParent('C:\\Users')).toBe('C:\\')
    expect(localParent('C:\\')).toBeUndefined()
    expect(localParent('/home/me')).toBe('/home')
    expect(localParent('/home')).toBe('/')
  })

  it('remoteParent', () => {
    expect(remoteParent('/srv/app')).toBe('/srv')
    expect(remoteParent('/srv')).toBe('/')
    expect(remoteParent('/')).toBeUndefined()
  })

  it('localCrumbs / remoteCrumbs：根到当前目录的祖先链', () => {
    expect(localCrumbs('C:\\Users\\me')).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'me', path: 'C:\\Users\\me' }
    ])
    expect(localCrumbs('D:\\')).toEqual([{ name: 'D:\\', path: 'D:\\' }])
    expect(remoteCrumbs('/home/ps')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'ps', path: '/home/ps' }
    ])
    expect(remoteCrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('isWindowsPath', () => {
    expect(isWindowsPath('C:\\Users')).toBe(true)
    expect(isWindowsPath('/home/ps')).toBe(false)
  })

  it('lastSegment：作为默认工作区名称', () => {
    expect(lastSegment('/home/ps/中山渔业/')).toBe('中山渔业')
    expect(lastSegment('D:\\code\\app')).toBe('app')
  })
})
