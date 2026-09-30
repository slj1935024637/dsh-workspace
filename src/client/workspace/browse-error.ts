/*
 * @Description: 目录浏览错误的归类 —— 把宿主 / 远程的原始报错整理成「标题 + 说明 + 原始信息」
 * @Author: YangHeng
 * @Date: 2026-09-30 11:00:00
 * @FilePath: /dsh-workspace/src/client/workspace/browse-error.ts
 *
 * 宿主 uiWorkspace.listDirectory / createDirectory 抛的是 DirectoryBrowseError：
 * message 形如 `directory browse failed: directory-picker/unreadable: cannot list X:\... : EINVAL: ...`，
 * 结构化的 code 在 rpcError.code。原样丢给用户既长又看不懂，这里只做归类，文案由调用方翻译。
 */

/** outdated：插件宿主端还是旧版本（新方法在网关上 404），需要完全重启 DSH。 */
export type BrowseErrorKind = 'unreadable' | 'exists' | 'create-failed' | 'outdated' | 'other'

export interface BrowseErrorInfo {
  kind: BrowseErrorKind
  /** 去掉「directory browse failed: <code>:」前缀后的原始信息，供展开查看 / 复制。 */
  detail: string
}

const PREFIX = /^directory browse failed:\s*/
const CODE = /^directory-picker\/([a-z-]+):\s*/

/** 把任意错误归成一类，并剥掉宿主包装的冗长前缀。 */
export function classifyBrowseError(error: unknown): BrowseErrorInfo {
  const raw = error instanceof Error ? error.message : String(error)
  let detail = raw.replace(PREFIX, '')
  let code = (error as { rpcError?: { code?: unknown } } | null)?.rpcError?.code
  const m = CODE.exec(detail)
  if (m !== null) {
    code ??= `directory-picker/${m[1]}`
    detail = detail.slice(m[0].length)
  }
  // 升级插件后只刷新了页面：浏览器端是新代码，宿主端仍是旧进程，新增的远程方法在网关上不存在。
  if (/transport failure for \/api\/[^:]+: HTTP 404/.test(detail)) return { kind: 'outdated', detail }
  const kind: BrowseErrorKind =
    code === 'directory-picker/unreadable'
      ? 'unreadable'
      : code === 'directory-picker/exists'
        ? 'exists'
        : code === 'directory-picker/create-failed'
          ? 'create-failed'
          : // 远程 SFTP 的权限 / 不存在也按「不可读」提示（服务端消息里会带 errno 名）。
            /\b(EACCES|EPERM|EINVAL|ENOENT|ENOTDIR|permission denied)\b/i.test(detail)
            ? 'unreadable'
            : 'other'
  return { kind, detail }
}

/**
 * 部分网盘 / 虚拟盘挂载（实测 115 网盘）对「空文件夹」的枚举直接返回失败，而不是空列表：
 * 驱动连 `.` / `..` 都不给，Win32 FindFirstFile 报 ERROR_FILE_NOT_FOUND（cmd 的 dir 显示 File Not Found），
 * Node 的 readdir 报 ENOENT、opendir 报 EINVAL。本机 NTFS 的空目录没有这个问题。
 * 命中后还要由调用方确认该目录确实存在（在上一级列表里），才能当空文件夹处理。
 */
export function isEmptyDirQuirk(error: unknown): boolean {
  const { detail } = classifyBrowseError(error)
  return /EINVAL: invalid argument, readdir|ENOENT: no such file or directory, scandir/.test(detail)
}

/**
 * Windows 卷根下的系统保留目录：普通用户列不了（网盘 / 虚拟盘挂载上还会报 EINVAL），
 * 某些挂载也不会给它们打隐藏属性，所以按名字归为隐藏，默认不显示。
 */
const WINDOWS_SYSTEM_DIRS = new Set(['system volume information', '$recycle.bin', 'recycler', 'config.msi', 'recovery', '$windows.~bt', '$windows.~ws'])

export function isSystemDirName(name: string): boolean {
  const lower = name.toLowerCase()
  return WINDOWS_SYSTEM_DIRS.has(lower) || (lower.startsWith('$') && lower.length > 1)
}
