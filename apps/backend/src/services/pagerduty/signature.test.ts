import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  pagerdutyEventIsStale,
  verifyPagerdutyWebhookSignature,
} from "./signature.js"

describe("PagerDuty webhook signatures", () => {
  it("accepts a v1 HMAC of the raw body", () => {
    const rawBody = Buffer.from('{"event":{}}')
    const secret = "secret"
    const digest = createHmac("sha256", secret).update(rawBody).digest("hex")
    expect(
      verifyPagerdutyWebhookSignature({
        rawBody,
        signatureHeader: `v1=${digest}`,
        secret,
      }),
    ).toBe(true)
  })

  it("rejects a tampered signature", () => {
    expect(
      verifyPagerdutyWebhookSignature({
        rawBody: Buffer.from("{}"),
        signatureHeader: "v1=deadbeef",
        secret: "secret",
      }),
    ).toBe(false)
  })

  it("treats events older than 15 minutes as stale", () => {
    expect(
      pagerdutyEventIsStale(new Date(Date.now() - 16 * 60 * 1000).toISOString()),
    ).toBe(true)
    expect(pagerdutyEventIsStale(new Date().toISOString())).toBe(false)
  })
})
