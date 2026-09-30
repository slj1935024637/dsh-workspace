/*
 * @Description: 浏览器端文件传输 —— 上传（带进度）与下载地址
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/files/transfer.ts
 */
import { ERROR_CODES, SFTP_HTTP_PREFIX } from '../../wire/contract.js'

/**
 * 页面是否由桌面版的自定义协议提供（DSH NEXT：dsh-app://app）。
 * 这类页面发往同源的请求由 Electron 转发给宿主并附上渲染进程令牌，但只认「主框架发出的子资源请求」：
 * 页面导航（<a download> 触发的下载就是一次导航）与 iframe 里的请求都拿不到令牌，会被拒绝。
 */
function isCustomSchemePage(): boolean {
  return typeof window !== 'undefined' && !/^https?:$/.test(window.location.protocol)
}

/** 传输失败。code 与 Typert 错误码同一套，页面可复用同样的分支（如锁定时弹解锁框）。 */
export class TransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'TransferError'
  }

  get isExists(): boolean {
    return this.code === ERROR_CODES.exists
  }

  get isLocked(): boolean {
    return this.code === ERROR_CODES.vaultLocked || this.code === ERROR_CODES.vaultUninitialized
  }
}

export interface UploadHandle {
  promise: Promise<{ path: string }>
  abort(): void
}

/**
 * 上传一个文件。用 XHR 而不是 fetch：fetch 拿不到上传进度，
 * 而几 GB 的文件没有进度条等于让用户对着空白干等。
 */
export function uploadFile(
  file: Blob,
  target: { hostId: string; dir: string; name: string; overwrite: boolean },
  onProgress: (loaded: number, total: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const query = new URLSearchParams({
    host: target.hostId,
    dir: target.dir,
    name: target.name,
    overwrite: target.overwrite ? '1' : '0'
  })
  const promise = new Promise<{ path: string }>((resolve, reject) => {
    // 必须是页面同源的相对地址：桌面版（dsh-app://app）只给同源请求附令牌，直连宿主 http 地址会被拒（Browser access is disabled）。
    xhr.open('POST', `${SFTP_HTTP_PREFIX}/upload?${query.toString()}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => {
      const body = parseJson(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ path: typeof body.path === 'string' ? body.path : '' })
      } else {
        reject(
          new TransferError(
            typeof body.code === 'string' ? body.code : ERROR_CODES.failed,
            typeof body.message === 'string' ? body.message : `上传失败（HTTP ${xhr.status}）`,
            xhr.status
          )
        )
      }
    }
    xhr.onerror = () => reject(new TransferError(ERROR_CODES.failed, '网络错误，上传中断。', 0))
    xhr.onabort = () => reject(new TransferError('dsh-workspace/aborted', '已取消上传。', 0))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

/** 下载地址（页面同源的相对地址）。 */
export function downloadUrl(hostId: string, remotePath: string): string {
  return `${SFTP_HTTP_PREFIX}/download?${new URLSearchParams({ host: hostId, path: remotePath }).toString()}`
}

/**
 * 触发浏览器下载。
 * 普通页面：<a download>，大文件不经过页面内存。必须带 download 属性：没有它时点击是一次页面导航，
 * 在 DSH Desktop（Electron）里会把整个界面带离当前页（遇到错误时直接停在 404 页）；有它则只触发下载。
 * 自定义协议页面（DSH NEXT）：导航请求拿不到令牌，改为 fetch（主框架子资源请求）取回再存盘。
 */
export function startDownload(hostId: string, remotePath: string): void {
  const url = downloadUrl(hostId, remotePath)
  if (isCustomSchemePage()) {
    void fetchDownload(url, baseName(remotePath))
    return
  }
  saveAs(url, baseName(remotePath))
}

function saveAs(href: string, name: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function fetchDownload(url: string, name: string): Promise<void> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) {
      const body = parseJson(await res.text())
      throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${res.status}`)
    }
    const blobUrl = URL.createObjectURL(await res.blob())
    saveAs(blobUrl, name)
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  } catch (err) {
    console.error('[dsh-workspace] 下载失败', err)
    window.alert(`下载失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ------------------------------------------------------------------ 远端路径（浏览器里没有 node:path）

export function parentOf(p: string): string {
  if (p === '/' || p === '') return '/'
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

export function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`
}

/** 面包屑：/a/b → [{/}, {/a}, {/a/b}] */
export function crumbs(p: string): Array<{ label: string; path: string }> {
  const parts = p.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    out.push({ label: part, path: acc })
  }
  return out
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 权限位 → rwxr-xr-x */
export function formatMode(mode: number): string {
  const bits = 'rwxrwxrwx'
  let out = ''
  for (let i = 0; i < 9; i += 1) out += mode & (1 << (8 - i)) ? bits[i] : '-'
  return out
}
