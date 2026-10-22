import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto"
import type { Env } from "../config/env.js"

const PREFIX = "ctxv1:"
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

const derivedKeys = new Map<string, Buffer>()

/** The key that is derived from AUTH_SECRET when no explicit key is set. */
function keyFromAuthSecret(authSecret: string): Buffer {
  let key = derivedKeys.get(authSecret)
  if (!key) {
    key = scryptSync(authSecret, "ctxpipe-connection-secrets", KEY_LENGTH)
    derivedKeys.set(authSecret, key)
  }
  return key
}

/** The key that encrypts. */
function currentKey(env: Env): Buffer {
  const explicit = env.CONNECTION_SECRETS_ENCRYPTION_KEY?.trim()
  return explicit
    ? Buffer.from(explicit, "hex")
    : keyFromAuthSecret(env.AUTH_SECRET)
}

/** The current key first, then the previous keys. */
function connectionSecretKeys(env: Env): Buffer[] {
  return [
    currentKey(env),
    ...(env.CONNECTION_SECRETS_PREVIOUS_KEYS ?? []).map((hex) =>
      Buffer.from(hex, "hex"),
    ),
    ...(env.PREVIOUS_AUTH_SECRET
      ? [keyFromAuthSecret(env.PREVIOUS_AUTH_SECRET)]
      : []),
  ]
}

/** Encrypt a UTF-8 string for storage in `connections.config`. */
export function encryptConnectionSecret(plaintext: string, env: Env): string {
  const key = currentKey(env)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  const out = Buffer.concat([iv, tag, enc])
  return `${PREFIX}${out.toString("base64url")}`
}

function decryptWithKey(raw: Buffer, key: Buffer): string | null {
  const iv = raw.subarray(0, IV_LENGTH)
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const data = raw.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    )
  } catch {
    return null
  }
}

/** The plaintext and the position of the key that opened it (0 is the current key). */
function decryptWithKeyList(
  ciphertext: string,
  env: Env,
): { plaintext: string; keyIndex: number } {
  if (!ciphertext.startsWith(PREFIX)) {
    throw new Error("Invalid encrypted secret format")
  }
  const raw = Buffer.from(ciphertext.slice(PREFIX.length), "base64url")
  if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted secret too short")
  }
  for (const [keyIndex, key] of connectionSecretKeys(env).entries()) {
    const plaintext = decryptWithKey(raw, key)
    if (plaintext !== null) return { plaintext, keyIndex }
  }
  throw new Error(
    "No configured key decrypts this stored secret. Add the old 64-hex key to CONNECTION_SECRETS_PREVIOUS_KEYS, or, when no explicit key was set, set PREVIOUS_AUTH_SECRET to the old AUTH_SECRET. Or enter the secret again.",
  )
}

/** Decrypt a value produced by `encryptConnectionSecret`, with the current key or a previous key. */
export function decryptConnectionSecret(ciphertext: string, env: Env): string {
  return decryptWithKeyList(ciphertext, env).plaintext
}

/**
 * The value encrypted again with the current key, or null when the current
 * key encrypted it already. Throws when no configured key decrypts it.
 */
export function reencryptConnectionSecret(
  ciphertext: string,
  env: Env,
): string | null {
  const { plaintext, keyIndex } = decryptWithKeyList(ciphertext, env)
  return keyIndex === 0 ? null : encryptConnectionSecret(plaintext, env)
}
