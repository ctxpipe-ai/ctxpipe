import { createHash } from "node:crypto"
import { base32nopad } from "@scure/base"
import { parse as uuidParse, v7 as uuidv7 } from "uuid"

/**
 * Generate an ID in the format `<prefix>_<base32 encoded uuidv7 bytes>`.
 * @param prefix - e.g. "repo", "org" (underscore is added automatically)
 */
export function generateObjectId(prefix: string): string {
  return `${prefix}_${base32nopad.encode(uuidParse(uuidv7())).toLowerCase()}`
}

/** Stable conversation id for a first-message Idempotency-Key. */
export function conversationIdFromIdempotencyKey(
  key: string,
  scope = "",
): string {
  const digest = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(key)
    .digest()
    .subarray(0, 16)
  return `conv_${base32nopad.encode(digest).toLowerCase()}`
}
