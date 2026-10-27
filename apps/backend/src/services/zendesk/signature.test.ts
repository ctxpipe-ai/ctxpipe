import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import { verifyZendeskWebhookSignature } from "./signature.js"

const secret = "webhook-signing-secret"
const rawBody = Buffer.from('{"type":"zen:event-type:article.published"}')
const nowMs = Date.parse("2026-10-14T00:00:00Z")
const timestamp = "2026-10-14T00:00:00Z"

const sign = (body: Buffer, at = timestamp, key = secret) =>
  createHmac("sha256", key)
    .update(`${at}${body.toString("utf8")}`)
    .digest("base64")

const verify = (
  signature: string | undefined,
  at: string | undefined = timestamp,
  body = rawBody,
) =>
  verifyZendeskWebhookSignature({
    rawBody: body,
    signature,
    timestamp: at,
    secret,
    nowMs,
  })

describe("verifyZendeskWebhookSignature", () => {
  it("accepts a base64 HMAC of the timestamp and the raw body", () => {
    expect(verify(sign(rawBody))).toBe(true)
  })

  it("rejects a changed body or another secret", () => {
    expect(verify(sign(rawBody), timestamp, Buffer.from("{}"))).toBe(false)
    expect(verify(sign(rawBody, timestamp, "other"))).toBe(false)
  })

  it("rejects a signature older than five minutes", () => {
    const old = "2026-10-13T23:54:59Z"
    expect(verify(sign(rawBody, old), old)).toBe(false)
    const recent = "2026-10-13T23:55:01Z"
    expect(verify(sign(rawBody, recent), recent)).toBe(true)
  })

  it.each([
    ["no signature", undefined, timestamp],
    ["no timestamp", "abc", undefined],
    ["a timestamp that is not a time", "abc", "yesterday"],
  ])("rejects %s", (_name, signature, at) => {
    expect(verify(signature, at)).toBe(false)
  })
})
