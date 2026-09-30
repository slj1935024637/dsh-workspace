/*
 * @Description: 本地工作区的 git 执行器 —— 直接以 argv 启动 git 进程（不经过 shell），带超时与输出上限
 * @Author: YangHeng
 * @Date: 2026-09-30 16:30:00
 * @FilePath: /dsh-workspace/src/local/local-git.ts
 */
import { spawn } from 'node:child_process'
import { access, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExecResult } from '../sftp/exec.js'
import { GIT_GLOBAL_ARGS, GitRepo, type GitRunner, type RunOpts } from '../git/remote-git.js'
import { isInside } from './local-fs.js'

/** 执行一次 git，截取 stdout（超过上限即终止进程）。git 不存在时返回 code 127 与说明。 */
export function spawnGit(cwd: string, argv: string[], options: RunOpts = {}): Promise<ExecResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 不弹凭据输入框、不抢锁：面板只做本地仓库操作，不该卡在交互提示上。
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.index !== undefined ? { GIT_INDEX_FILE: options.index } : {})
    }
    let child
    try {
      child = spawn('git', [...GIT_GLOBAL_ARGS, ...argv], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ stdout: '', stderr: `git: command not found (${error instanceof Error ? error.message : String(error)})`, code: 127, timedOut: false, truncated: false })
      return
    }
    const out: Buffer[] = []
    const errOut: Buffer[] = []
    let size = 0
    let timedOut = false
    let truncated = false
    let settled = false
    const finish = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = maxBytes - size
      if (chunk.length >= room) {
        out.push(chunk.subarray(0, Math.max(0, room)))
        size = maxBytes
        truncated = true
        child.kill()
        return
      }
      out.push(chunk)
      size += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errOut.reduce((n, b) => n + b.length, 0) < 8192) errOut.push(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT'
      finish({
        stdout: '',
        stderr: missing ? 'git: command not found (ENOENT)' : error.message,
        code: missing ? 127 : null,
        timedOut: false,
        truncated: false
      })
    })
    child.on('close', (code) => {
      finish({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        code: timedOut || truncated ? null : code,
        timedOut,
        truncated
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

export function localGitRunner(root: string): GitRunner {
  const win = process.platform === 'win32'
  return {
    noGitMessage: '本机未检测到 git（请安装 Git 并确保 git 在 PATH 中）。',
    pathKey: (p) => (win ? p.replace(/\\/g, '/').toLowerCase() : p),
    git: (argv, options) => spawnGit(root, argv, options),
    async catRelative(rel, maxBytes) {
      const file = path.join(root, rel)
      try {
        // 仓库里的符号链接可能指向工作区外：只读工作区内的真实文件。
        const real = await realpath(file)
        if (!isInside(await realpath(root), real)) return { stdout: '', code: 1, truncated: false }
        const handle = await open(real, 'r')
        try {
          const buffer = Buffer.alloc(maxBytes)
          const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
          return { stdout: buffer.subarray(0, bytesRead).toString('utf8'), code: 0, truncated: bytesRead >= maxBytes }
        } finally {
          await handle.close()
        }
      } catch {
        return { stdout: '', code: 1, truncated: false }
      }
    },
    async readText(abs) {
      try {
        return await readFile(abs, 'utf8')
      } catch {
        return undefined
      }
    },
    async exists(abs) {
      try {
        await access(abs)
        return true
      } catch {
        return false
      }
    },
    async writeText(abs, text) {
      await writeFile(abs, text, 'utf8')
    },
    async mkdirp(abs) {
      await mkdir(abs, { recursive: true })
    },
    async rm(abs) {
      for (const p of abs) await rm(p, { force: true })
    }
  }
}

/** 本地工作区的 git。root 为原生路径。 */
export class LocalGit extends GitRepo {
  constructor(root: string) {
    super(localGitRunner(root), root)
  }
}
