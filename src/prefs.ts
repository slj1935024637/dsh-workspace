/*
 * @Description: 插件偏好设置（忽略规则、接管「添加工作区」、接管「文件」侧栏）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/prefs.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { renameWithRetry } from './fs-atomic.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pluginRoot } from './paths.js'

export interface Prefs {
  /** 用户追加的忽略规则（.gitignore 写法），叠加在内置默认规则之后。 */
  ignore: string[]
  /**
   * 接管「添加工作区」（侧栏按钮 / 首页 / 快捷键），弹出本插件的本地 + 远程弹窗。
   * 默认开启；关闭后恢复 DSH 原来的选择器（刷新页面生效）。
   */
  takeoverAddWorkspace: boolean
  /**
   * 接管 DSH 自带的「文件」侧栏（kind files），换成本插件的「文件管理」。默认开启；
   * 其他插件（如 better-sidebar）已接管时不抢，只提示。
   */
  takeoverFilesSidebar: boolean
}

const DEFAULTS: Prefs = { ignore: [], takeoverAddWorkspace: true, takeoverFilesSidebar: true }

export function prefsFile(): string {
  return path.join(pluginRoot(), 'prefs.json')
}

export class PrefsStore {
  private data: Prefs | undefined

  get(): Prefs {
    if (this.data !== undefined) return this.data
    const file = prefsFile()
    if (!existsSync(file)) return (this.data = { ...DEFAULTS })
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Prefs>
      this.data = {
        ignore: Array.isArray(parsed.ignore) ? parsed.ignore.filter((s): s is string => typeof s === 'string') : [],
        takeoverAddWorkspace: parsed.takeoverAddWorkspace !== false,
        takeoverFilesSidebar: parsed.takeoverFilesSidebar !== false
      }
    } catch {
      // 偏好文件损坏不应影响主功能：退回默认值（下次保存会覆盖修复）。
      this.data = { ...DEFAULTS }
    }
    return this.data
  }

  setIgnore(rules: string[]): Prefs {
    const cleaned = rules.map((r) => r.trim()).filter((r) => r !== '')
    return this.save({ ...this.get(), ignore: cleaned })
  }

  setTakeover(enabled: boolean): Prefs {
    return this.save({ ...this.get(), takeoverAddWorkspace: enabled })
  }

  setFilesTakeover(enabled: boolean): Prefs {
    return this.save({ ...this.get(), takeoverFilesSidebar: enabled })
  }

  private save(next: Prefs): Prefs {
    const file = prefsFile()
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(tmp, file)
    this.data = next
    return next
  }
}
