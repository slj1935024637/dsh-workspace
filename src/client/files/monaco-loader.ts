/*
 * @Description: 按需加载 Monaco 编辑器 —— 经远程调用分段取回脚本，blob 地址加载
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/files/monaco-loader.ts
 *
 * 为什么不直接 <script src="/dsh-workspace/assets/monaco.js">：DSH Desktop 里插件的 HTTP 路由
 * 实测不可达（404）。改为走浏览器与宿主之间的远程调用通道（文件列表等功能在用、确认可用），
 * 网页版 / 桌面版行为一致。脚本约 4.8MB，只在第一次打开文件时获取，之后整页复用。
 */
// 仅类型导入：编译后擦除，Monaco 代码不会进入 client.js。
import type * as MonacoApi from 'monaco-editor'
import type { EditorAssetName } from '../../wire/contract.js'
import type { EditorAssetOutput } from '../../wire/dto.js'

export type Monaco = typeof MonacoApi

/** 取资源的一段（由调用方注入远程调用）。 */
export type AssetFetcher = (name: EditorAssetName, index: number) => Promise<EditorAssetOutput>

declare global {
  interface Window {
    __dshwsMonaco?: { api: Monaco; version: string }
    /** 编辑器 worker 的地址，由本模块在加载主脚本前设置。 */
    __dshwsMonacoWorkerUrl?: string
  }
}

const TIMEOUT_MS = 120_000

let loading: Promise<Monaco> | undefined

/** 取回完整资源文本：先取第 0 段得知总段数，再顺序取剩余各段。 */
async function fetchAsset(fetcher: AssetFetcher, name: EditorAssetName): Promise<string> {
  const first = await fetcher(name, 0)
  const parts = [first.chunk]
  for (let i = 1; i < first.total; i += 1) {
    const part = await fetcher(name, i)
    // 取的过程中宿主上的资源被替换（插件升级），拼出来的会是两个版本的混合 —— 直接失败重来。
    if (part.version !== first.version) throw new Error('编辑器资源在加载过程中发生变化，请重新打开文件。')
    parts.push(part.chunk)
  }
  return parts.join('')
}

const toBlobUrl = (code: string): string => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))

/** 加载 Monaco；并发调用共享同一次加载，失败后允许重试。 */
export function loadMonaco(fetcher: AssetFetcher): Promise<Monaco> {
  const ready = window.__dshwsMonaco
  if (ready !== undefined) return Promise.resolve(ready.api)
  if (loading !== undefined) return loading

  loading = (async () => {
    // worker 先就位：主脚本初始化时可能立即创建 worker。
    window.__dshwsMonacoWorkerUrl ??= toBlobUrl(await fetchAsset(fetcher, 'editor.worker.js'))
    const mainUrl = toBlobUrl(await fetchAsset(fetcher, 'monaco.js'))
    return await runScript(mainUrl)
  })().catch((error: unknown) => {
    // 失败不缓存：下次打开文件时重新尝试（如宿主刚好在重载插件）。
    loading = undefined
    throw error
  })
  return loading
}

/** 执行主脚本并等待其初始化完成事件。 */
function runScript(url: string): Promise<Monaco> {
  return new Promise<Monaco>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    const timer = setTimeout(() => fail(new Error('加载编辑器超时。')), TIMEOUT_MS)
    const done = (): void => {
      clearTimeout(timer)
      window.removeEventListener('dshws-monaco-ready', onReady)
    }
    const onReady = (): void => {
      done()
      const loaded = window.__dshwsMonaco
      if (loaded === undefined) fail(new Error('编辑器脚本已加载，但未完成初始化。'))
      else resolve(loaded.api)
    }
    const fail = (error: Error): void => {
      done()
      script.remove()
      URL.revokeObjectURL(url)
      reject(error)
    }
    window.addEventListener('dshws-monaco-ready', onReady)
    script.onerror = () => fail(new Error('编辑器脚本执行失败。'))
    document.head.appendChild(script)
  })
}

/**
 * 按文件名推断语言：先精确文件名（Dockerfile、Makefile），再扩展名，最后首行（#!/bin/bash）。
 * 找不到返回 plaintext。
 */
export function languageFor(monaco: Monaco, fileName: string, firstLine: string): string {
  return pickLanguage(monaco.languages.getLanguages(), fileName, firstLine)
}

/** 语言注册信息的最小结构（Monaco ILanguageExtensionPoint 的子集）。 */
export interface LanguageInfo {
  id: string
  extensions?: string[]
  filenames?: string[]
  firstLine?: string
  aliases?: string[]
}

/** 纯函数版本：便于用真实浏览器里取到的语言表做测试。 */
export function pickLanguage(languages: readonly LanguageInfo[], fileName: string, firstLine: string): string {
  const name = fileName.toLowerCase()
  for (const lang of languages) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
  }
  // 最长扩展名优先：.d.ts 优于 .ts
  let best: { id: string; len: number } | undefined
  for (const lang of languages) {
    for (const ext of lang.extensions ?? []) {
      const e = ext.toLowerCase()
      if (name.endsWith(e) && (best === undefined || e.length > best.len)) best = { id: lang.id, len: e.length }
    }
  }
  if (best !== undefined) return best.id
  for (const lang of languages) {
    if (lang.firstLine !== undefined) {
      try {
        if (new RegExp(lang.firstLine).test(firstLine)) return lang.id
      } catch {
        /* 个别语言的 firstLine 不是合法 JS 正则，忽略 */
      }
    }
  }
  // 服务器上大量无扩展名的脚本只能靠 shebang 判断；Monaco 的 shell 等定义没有 firstLine 规则。
  // 解释器 = 第一个路径的最后一段；若是 env 则取其后第一个非选项参数（跳过 -S 之类）。python3.11 → python。
  const parts = /^#!\s*(.+)$/.exec(firstLine)?.[1]?.trim().split(/\s+/) ?? []
  let program = parts[0]?.split('/').pop()
  if (program === 'env') program = parts.slice(1).find((p) => !p.startsWith('-'))
  const shebang = program?.toLowerCase().replace(/[\d.]+$/, '')
  const byInterpreter: Record<string, string> = {
    sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', dash: 'shell', ash: 'shell',
    python: 'python', node: 'javascript', perl: 'perl', ruby: 'ruby', php: 'php', lua: 'lua'
  }
  const guess = shebang !== undefined ? byInterpreter[shebang] : undefined
  if (guess !== undefined && languages.some((l) => l.id === guess)) return guess
  return 'plaintext'
}

/** 手动切换语言用的下拉选项：按显示名排序，plaintext 置顶。 */
export function languageOptions(languages: readonly LanguageInfo[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ id: string; label: string }> = []
  for (const lang of languages) {
    if (seen.has(lang.id)) continue
    seen.add(lang.id)
    options.push({ id: lang.id, label: lang.aliases?.[0] ?? lang.id })
  }
  options.sort((a, b) => (a.id === 'plaintext' ? -1 : b.id === 'plaintext' ? 1 : a.label.localeCompare(b.label)))
  return options
}
