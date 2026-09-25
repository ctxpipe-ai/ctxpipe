import { describe, expect, it } from "vitest"
import {
  ACTOR_TYPES,
  attributesForOrgApiKey,
  resolveRequestId,
  sanitizeAttribution,
} from "./attribution.js"

describe("resolveRequestId", () => {
  it("reuses a sane incoming x-request-id", () => {
    expect(resolveRequestId("req_abc-123")).toEqual({
      id: "req_abc-123",
      reused: true,
    })
  })

  it("generates an id when the header is missing or unsafe", () => {
    const missing = resolveRequestId(undefined)
    expect(missing.reused).toBe(false)
    expect(missing.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(resolveRequestId("has spaces").reused).toBe(false)
    expect(resolveRequestId("a".repeat(200)).reused).toBe(false)
  })
})

describe("attribution attributes", () => {
  it("keeps the api key id and drops the secret", () => {
    const secret = "sk_live_do_not_log"
    const attrs = attributesForOrgApiKey(
      { id: "key_1", orgId: "org_1", secret },
      "acme",
    )
    expect(attrs).toEqual({
      "ctxpipe.actor.type": "org_api_key",
      "ctxpipe.api_key.id": "key_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
    expect(JSON.stringify(attrs)).not.toContain(secret)
  })

  it("only emits contract keys for each actor type", () => {
    for (const actorType of ACTOR_TYPES) {
      const attrs = sanitizeAttribution({
        "ctxpipe.actor.type": actorType,
        "enduser.id": actorType === "org_api_key" ? undefined : "user_1",
        secret: "nope",
      } as never)
      expect(attrs["ctxpipe.actor.type"]).toBe(actorType)
      expect(attrs).not.toHaveProperty("secret")
    }
  })
})
