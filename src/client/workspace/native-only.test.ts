/*
 * @Description: 宿主只提供 native 目录选择器时的错误识别
 * @Author: YangHeng
 * @Date: 2026-09-30 10:30:00
 * @FilePath: /dsh-workspace/src/client/workspace/native-only.test.ts
 */
import { describe, expect, it } from 'vitest'
import { isBrowseUnavailable } from './native-picker.js'

describe('isBrowseUnavailable', () => {
  it('识别宿主 DirectoryBrowseError（rpcError.code）', () => {
    const err = Object.assign(new Error('directory browse failed: x'), { rpcError: { code: 'directory-picker/unavailable' } })
    expect(isBrowseUnavailable(err)).toBe(true)
  })

  it('识别用户反馈里的原始报错文字', () => {
    const err = new Error(
      'directory browse failed: directory-picker/unavailable: directoryPicker.list needs the browse capability; the composed picker serves "native"'
    )
    expect(isBrowseUnavailable(err)).toBe(true)
  })

  it('其他错误不误判', () => {
    expect(isBrowseUnavailable(new Error('EACCES: permission denied'))).toBe(false)
    expect(isBrowseUnavailable(null)).toBe(false)
  })
})
