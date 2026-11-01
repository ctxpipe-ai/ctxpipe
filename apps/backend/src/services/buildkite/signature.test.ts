import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import { verifyBuildkiteWebhookSignature } from "./signature.js"

const token = "webhook-token"
const rawBody = Buffer.from('{"event":"build.finished"}')
const nowMs = Date.parse("2026-10-13T00:00:00.000Z")
const timestamp = String(nowMs / 1000)

function sign(body: Buffer, at = timestamp, key = token) {
  const signature = createHmac("sha256", key)
    .update(`${at}.${body.toString("utf8")}`)
    .digest("hex")
  return `timestamp=${at},signature=${signature}`
}

const verify = (signatureHeader: string | undefined, body = rawBody) =>
  verifyBuildkiteWebhookSignature({
    rawBody: body,
    signatureHeader,
    token,
    nowMs,
  })

describe("verifyBuildkiteWebhookSignature", () => {
  it("accepts an HMAC of the timestamp and the raw body", () => {
    expect(verify(sign(rawBody))).toBe(true)
  })

  it("rejects a changed body", () => {
    expect(
      verify(sign(rawBody), Buffer.from('{"event":"build.finished" }')),
    ).toBe(false)
  })

  it("rejects a signature with another token", () => {
    expect(verify(sign(rawBody, timestamp, "other-token"))).toBe(false)
  })

  it("rejects a signature older than five minutes", () => {
    expect(verify(sign(rawBody, String(nowMs / 1000 - 301)))).toBe(false)
    expect(verify(sign(rawBody, String(nowMs / 1000 - 299)))).toBe(true)
  })

  it.each([
    ["no header", undefined],
    ["a token-mode delivery", ""],
    ["no timestamp", "signature=abc"],
    ["no signature", `timestamp=${timestamp}`],
  ])("rejects %s", (_name, header) => {
    expect(verify(header)).toBe(false)
  })
})
