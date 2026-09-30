/*
 * @Description: 宿主目录选择能力为 native（只能弹系统对话框、不能列目录）时的识别与取用
 * @Author: YangHeng
 * @Date: 2026-09-30 10:30:00
 * @FilePath: /dsh-workspace/src/client/workspace/native-picker.ts
 *
 * 宿主的目录选择能力是「二选一」组合出来的（dsh-api-workspace-controller 的 requireCapability）：
 * browse（可列目录）或 native（macOS / Windows 桌面等，只弹系统对话框）。
 * native 时 uiWorkspace.listDirectory 固定抛 directory-picker/unavailable —— 这不是故障，要切到「系统对话框」模式。
 */

/** 本模块用到的 uiWorkspace 子集。 */
export interface NativePickHost {
  pickDirectory?(): Promise<string | null>
}

declare global {
  interface Window {
    /** DSH Desktop 注入的原生选择文件夹对话框（桌面版才有）。 */
    __DSH_DESKTOP_PICK_DIRECTORY__?: () => Promise<string | null>
    /** DSH 桌面壳注入的目录选择器（官方 native picker 优先用它）。 */
    __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
  }
}

/** 是否是「宿主不支持浏览目录」的错误（宿主 DirectoryBrowseError 带 rpcError.code，兜底按文字判断）。 */
export function isBrowseUnavailable(error: unknown): boolean {
  const code = (error as { rpcError?: { code?: unknown } } | null)?.rpcError?.code
  if (code === 'directory-picker/unavailable') return true
  return error instanceof Error && error.message.includes('directory-picker/unavailable')
}

/** 与官方 native picker 相同的取用顺序：桌面壳注入 → 旧桌面接口 → 宿主 RPC（在宿主机上弹对话框）。 */
export function nativePicker(ui: NativePickHost | undefined): (() => Promise<string | null>) | undefined {
  if (typeof window !== 'undefined') {
    const shell = window.__DSH_DIRECTORY_PICKER__
    if (shell !== undefined && typeof shell.pick === 'function') return () => shell.pick()
    const legacy = window.__DSH_DESKTOP_PICK_DIRECTORY__
    if (typeof legacy === 'function') return legacy
  }
  const pick = ui?.pickDirectory
  if (ui !== undefined && typeof pick === 'function') return () => pick.call(ui)
  return undefined
}
