import { createHmac, timingSafeEqual } from "node:crypto"

const MAX_SKEW_SECONDS = 60 * 5

/**
 * Verify Slack Events / Slash request signature.
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack
 */
export function verifySlackRequestSignature(input: {
  signingSecret: string
  signatureHeader: string | undefined
  timestampHeader: string | undefined
  rawBody: string
  nowSeconds?: number
}): boolean {
  const signature = input.signatureHeader?.trim()
  const timestamp = input.timestampHeader?.trim()
  if (!signature || !timestamp) return false
  if (!/^\d+$/.test(timestamp)) return false

  const ts = Number(timestamp)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false

  const base = `v0:${timestamp}:${input.rawBody}`
  const digest = createHmac("sha256", input.signingSecret)
    .update(base, "utf8")
    .digest("hex")
  const expected = `v0=${digest}`

  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
