/*
 * @Description: 远程「粘贴」的目标命名测试 —— 同名时依次取「名称 copy」「名称 copy 2」…
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/copy-name.test.ts
 */
import { describe, expect, it } from 'vitest'
import { copyNameCandidates } from './remote-fs.js'

describe('copyNameCandidates', () => {
  it('文件保留扩展名；目录与隐藏文件不拆扩展名', () => {
    const file = copyNameCandidates('app.test.ts', false)
    expect([0, 1, 2, 3].map(file)).toEqual(['app.test.ts', 'app.test copy.ts', 'app.test copy 2.ts', 'app.test copy 3.ts'])
    expect(copyNameCandidates('src.v2', true)(1)).toBe('src.v2 copy')
    expect(copyNameCandidates('.env', false)(1)).toBe('.env copy')
    expect(copyNameCandidates('Makefile', false)(2)).toBe('Makefile copy 2')
  })
})
