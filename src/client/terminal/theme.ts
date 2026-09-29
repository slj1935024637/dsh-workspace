/*
 * @Description: 终端配色 —— 从宿主主题变量解析，随明暗主题变化
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/terminal/theme.ts
 */
import type { ITheme } from '@xterm/xterm'

/**
 * 解析一个 CSS 颜色表达式为浏览器计算后的 rgb() 字符串。
 *
 * 为什么不直接读 getPropertyValue('--x')：变量值可能是 color-mix()、oklch()
 * 或另一个 var()，xterm 自带的颜色解析器不认。借一个探针元素让浏览器算出最终颜色，
 * 拿到的永远是 rgb()/rgba()。
 */
export function resolveColor(expression: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = fallback
  probe.style.color = expression
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value === '' ? fallback : value
}

/** 由 rgb()/rgba() 估算亮度，判断当前是浅色还是深色背景。 */
export function isLight(rgb: string): boolean {
  const match = rgb.match(/\d+(\.\d+)?/g)
  if (match === null || match.length < 3) return false
  const [r, g, b] = match.slice(0, 3).map(Number) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140
}

/** 深色背景下的 ANSI 16 色（取自 VS Code Dark+，对比度经过广泛验证）。 */
const DARK_ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

/** 浅色背景下的 ANSI 16 色（VS Code Light+）：深色版的黄色、白色在白底上看不清。 */
const LIGHT_ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

/** 按宿主当前主题生成 xterm 配色。 */
export function themeFromHost(): ITheme {
  const background = resolveColor('var(--dsw-alias-bg-layer-1)', '#1e1e1e')
  const foreground = resolveColor('var(--dsw-alias-label-primary)', '#d4d4d4')
  const light = isLight(background)
  return {
    background,
    foreground,
    cursor: resolveColor('var(--dsw-alias-brand-primary)', light ? '#333333' : '#ffffff'),
    cursorAccent: background,
    selectionBackground: light ? 'rgba(0, 100, 255, 0.25)' : 'rgba(120, 170, 255, 0.35)',
    ...(light ? LIGHT_ANSI : DARK_ANSI)
  }
}

/**
 * 订阅宿主主题切换。宿主通过改 <html> 的 class / data-theme / style 切换主题，
 * 监听这些属性即可，不依赖宿主暴露任何主题 API。
 */
export function onHostThemeChange(callback: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
  const observer = new MutationObserver(() => callback())
  for (const target of [document.documentElement, document.body]) {
    observer.observe(target, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  }
  const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined
  media?.addEventListener?.('change', callback)
  return () => {
    observer.disconnect()
    media?.removeEventListener?.('change', callback)
  }
}
