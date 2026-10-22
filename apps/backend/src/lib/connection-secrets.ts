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

/** The prefix of a `CONNECTION_SECRETS_PREVIOUS_KEYS` entry that holds an old AUTH_SECRET. */
export const PREVIOUS_AUTH_SECRET_PREFIX = "auth-secret:"

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

function keyFromPreviousEntry(entry: string): Buffer {
  if (entry.startsWith(PREVIOUS_AUTH_SECRET_PREFIX)) {
    return keyFromAuthSecret(entry.slice(PREVIOUS_AUTH_SECRET_PREFIX.length))
  }
  return Buffer.from(entry, "hex")
}

/** The entries of `CONNECTION_SECRETS_PREVIOUS_KEYS`, in order. */
export function previousKeyEntries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** The current key first, then the previous keys. Encrypt only with the first. */
function connectionSecretKeys(env: Env): Buffer[] {
  const current = env.CONNECTION_SECRETS_ENCRYPTION_KEY?.trim()
  return [
    current ? Buffer.from(current, "hex") : keyFromAuthSecret(env.AUTH_SECRET),
    ...previousKeyEntries(env.CONNECTION_SECRETS_PREVIOUS_KEYS).map(
      keyFromPreviousEntry,
    ),
  ]
}

/** Encrypt a UTF-8 string for storage in `connections.config`. */
export function encryptConnectionSecret(plaintext: string, env: Env): string {
  const [key] = connectionSecretKeys(env)
  if (!key) throw new Error("No connection secret key")
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
    "No configured key decrypts this stored secret. Add the key that encrypted it to CONNECTION_SECRETS_PREVIOUS_KEYS (a 64-hex key, or auth-secret:<old AUTH_SECRET> when no explicit key was set), or enter the secret again.",
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
