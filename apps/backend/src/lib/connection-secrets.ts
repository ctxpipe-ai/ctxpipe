import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import type { Env } from "../config/env.js"

const PREFIX = "ctxv1:"
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

function decodeKeyMaterial(env: Env): Buffer {
  const raw = env.CONNECTION_SECRETS_ENCRYPTION_KEY?.trim()
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, "hex")
    }
    throw new Error(
      "CONNECTION_SECRETS_ENCRYPTION_KEY must be 64 hex characters (32-byte AES key)",
    )
  }
  return scryptSync(env.AUTH_SECRET, "ctxpipe-connection-secrets", KEY_LENGTH)
}

/** Encrypt a UTF-8 string for storage in `connections.config`. */
export function encryptConnectionSecret(plaintext: string, env: Env): string {
  const key = decodeKeyMaterial(env)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  const out = Buffer.concat([iv, tag, enc])
  return `${PREFIX}${out.toString("base64url")}`
}

/** Decrypt a value produced by `encryptConnectionSecret`. */
export function decryptConnectionSecret(ciphertext: string, env: Env): string {
  if (!ciphertext.startsWith(PREFIX)) {
    throw new Error("Invalid encrypted secret format")
  }
  const raw = Buffer.from(ciphertext.slice(PREFIX.length), "base64url")
  if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted secret too short")
  }
  const iv = raw.subarray(0, IV_LENGTH)
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const data = raw.subarray(IV_LENGTH + TAG_LENGTH)
  const key = decodeKeyMaterial(env)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  )
}
