/*
 * @Description: 浏览器端文件传输 —— 上传（带进度）与下载地址
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/files/transfer.ts
 */
import { ERROR_CODES, SFTP_HTTP_PREFIX } from '../../wire/contract.js'

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

/** 下载地址。直接交给浏览器下载，大文件不经过页面内存。 */
export function downloadUrl(hostId: string, remotePath: string): string {
  return `${SFTP_HTTP_PREFIX}/download?${new URLSearchParams({ host: hostId, path: remotePath }).toString()}`
}

/**
 * 触发浏览器下载。
 * 必须带 download 属性：没有它时点击是一次页面导航，在 DSH Desktop（Electron）里会把整个界面
 * 带离当前页（遇到错误时直接停在 404 页）；有它则同源下只触发下载，页面原地不动。
 */
export function startDownload(hostId: string, remotePath: string): void {
  const a = document.createElement('a')
  a.href = downloadUrl(hostId, remotePath)
  a.download = baseName(remotePath)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
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
