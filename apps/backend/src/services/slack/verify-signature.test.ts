import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { verifySlackRequestSignature } from "./verify-signature.js"

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`, "utf8")
    .digest("hex")
  return `v0=${digest}`
}

describe("verifySlackRequestSignature", () => {
  const secret = "test-signing-secret"
  const body = '{"type":"url_verification","challenge":"abc"}'
  const ts = "1710000000"

  it("accepts a valid signature within skew", () => {
    expect(
      verifySlackRequestSignature({
        signingSecret: secret,
        signatureHeader: sign(secret, ts, body),
        timestampHeader: ts,
        rawBody: body,
        nowSeconds: Number(ts) + 30,
      }),
    ).toBe(true)
  })

  it("rejects bad signature", () => {
    expect(
      verifySlackRequestSignature({
        signingSecret: secret,
        signatureHeader: "v0=deadbeef",
        timestampHeader: ts,
        rawBody: body,
        nowSeconds: Number(ts),
      }),
    ).toBe(false)
  })

  it("rejects stale timestamps", () => {
    expect(
      verifySlackRequestSignature({
        signingSecret: secret,
        signatureHeader: sign(secret, ts, body),
        timestampHeader: ts,
        rawBody: body,
        nowSeconds: Number(ts) + 60 * 10,
      }),
    ).toBe(false)
  })
})
