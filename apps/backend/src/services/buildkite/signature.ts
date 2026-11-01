import { createHmac, timingSafeEqual } from "node:crypto"

/** Buildkite's advice: refuse a signature older than five minutes. */
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60

/**
 * Verify `X-Buildkite-Signature` (`timestamp=<unix seconds>,signature=<hex>`):
 * an HMAC-SHA256 of `<timestamp>.<raw body>` with the webhook token as the
 * key. A webhook in token mode sends no signature, so it fails here.
 */
export function verifyBuildkiteWebhookSignature(input: {
  rawBody: Buffer
  signatureHeader: string | undefined
  token: string
  nowMs?: number
}): boolean {
  const parts = new Map(
    (input.signatureHeader ?? "").split(",").map((part) => {
      const [name = "", ...value] = part.trim().split("=")
      return [name, value.join("=")] as const
    }),
  )
  const timestamp = parts.get("timestamp") ?? ""
  const signature = parts.get("signature") ?? ""
  if (!/^\d+$/.test(timestamp) || !signature) return false
  const ageSeconds = Math.abs(
    (input.nowMs ?? Date.now()) / 1000 - Number(timestamp),
  )
  if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return false
  const expected = Buffer.from(
    createHmac("sha256", input.token)
      .update(`${timestamp}.`)
      .update(input.rawBody)
      .digest("hex"),
    "utf8",
  )
  const actual = Buffer.from(signature, "utf8")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
