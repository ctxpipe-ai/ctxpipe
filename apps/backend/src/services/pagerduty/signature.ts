import { createHmac, timingSafeEqual } from "node:crypto"

const MAX_EVENT_AGE_MS = 15 * 60 * 1000

export function pagerdutySignatureHeaderValues(header: string): string[] {
  return header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3))
}

export function verifyPagerdutyWebhookSignature(input: {
  rawBody: Buffer
  signatureHeader: string | undefined
  secret: string
}): boolean {
  if (!input.signatureHeader) return false
  const actuals = pagerdutySignatureHeaderValues(input.signatureHeader)
  if (actuals.length === 0) return false
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex")
  const expectedBuf = Buffer.from(expected, "utf8")
  return actuals.some((actual) => {
    const actualBuf = Buffer.from(actual, "utf8")
    return (
      actualBuf.length === expectedBuf.length &&
      timingSafeEqual(actualBuf, expectedBuf)
    )
  })
}

export function pagerdutyEventIsStale(
  occurredAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!occurredAt) return false
  const parsed = Date.parse(occurredAt)
  if (Number.isNaN(parsed)) return false
  return now - parsed > MAX_EVENT_AGE_MS
}
