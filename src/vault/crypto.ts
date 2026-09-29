/*
 * @Description: 凭据加解密 —— 主密码派生密钥，AES-256-GCM
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/vault/crypto.ts
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'

/**
 * 加密信封。只有敏感字段走这里：
 * 主机名、用户名、分组保持明文，这样未解锁时 UI 仍能显示主机列表，
 * 只是连不上 —— 看列表是无害的，而「没解锁就一片空白」是糟糕体验。
 */
export interface Sealed {
  /** 密文（base64）。 */
  c: string
  /** 初始化向量（base64）。 */
  iv: string
  /** GCM 认证标签（base64）。 */
  t: string
}

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
/** scrypt 代价参数。N=2^15 在本机约 100ms 量级，足够挡住离线爆破又不影响交互。 */
const SCRYPT_COST = 32768
const SCRYPT_BLOCK = 8
const SCRYPT_PARALLEL = 1
/** scrypt 默认 maxmem 在 N=32768 时不够用，显式放宽。 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/** 派生密钥。salt 随保险箱一同持久化（明文，salt 不是秘密）。 */
export function deriveKey(masterPassword: string, salt: Buffer): Buffer {
  return scryptSync(masterPassword, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: SCRYPT_MAXMEM
  })
}

/** 生成新的 salt（初始化保险箱时调用一次）。 */
export function newSalt(): Buffer {
  return randomBytes(16)
}

/** 加密一段明文。 */
export function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    c: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    t: cipher.getAuthTag().toString('base64')
  }
}

/**
 * 解密。认证标签校验失败会抛错 —— 这既可能是密码错，
 * 也可能是密文被篡改，两者都不该静默返回空值。
 */
export function open(key: Buffer, sealed: Sealed): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.t, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(sealed.c, 'base64')),
    decipher.final()
  ])
  return decrypted.toString('utf8')
}

/**
 * 主密码校验串：用派生密钥加密一个固定常量并存下来。
 * 解锁时重新加密比对不可行（GCM 的 iv 随机），所以改为解密后比对明文。
 */
const VERIFIER_PLAINTEXT = 'dsh-workspace-vault-v1'

export function makeVerifier(key: Buffer): Sealed {
  return seal(key, VERIFIER_PLAINTEXT)
}

/** 校验主密码是否正确。任何异常都视为密码错误，不向上暴露细节。 */
export function checkVerifier(key: Buffer, verifier: Sealed): boolean {
  try {
    const plain = open(key, verifier)
    const a = Buffer.from(plain, 'utf8')
    const b = Buffer.from(VERIFIER_PLAINTEXT, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** 判断一个值是否为加密信封。 */
export function isSealed(value: unknown): value is Sealed {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.c === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.t === 'string'
  )
}
