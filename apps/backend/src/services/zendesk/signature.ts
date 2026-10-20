import { createHmac, timingSafeEqual } from "node:crypto"

/** Refuse a delivery whose signature timestamp is older than this. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

/**
 * Verify `X-Zendesk-Webhook-Signature`: base64 of an HMAC-SHA256 of the
 * `X-Zendesk-Webhook-Signature-Timestamp` value and the raw body, with the
 * signing secret of the webhook as the key.
 */
export function verifyZendeskWebhookSignature(input: {
  rawBody: Buffer
  signature: string | undefined
  timestamp: string | undefined
  secret: string
  nowMs?: number
}): boolean {
  if (!input.signature || !input.timestamp) return false
  const sentMs = Date.parse(input.timestamp)
  if (
    Number.isNaN(sentMs) ||
    Math.abs((input.nowMs ?? Date.now()) - sentMs) > MAX_SIGNATURE_AGE_MS
  )
    return false
  const expected = Buffer.from(
    createHmac("sha256", input.secret)
      .update(input.timestamp)
      .update(input.rawBody)
      .digest("base64"),
  )
  const actual = Buffer.from(input.signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
