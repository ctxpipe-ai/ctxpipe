import { propagation, ROOT_CONTEXT } from "@opentelemetry/api"
import { W3CBaggagePropagator } from "@opentelemetry/core"
import { beforeAll, describe, expect, it } from "vitest"
import {
  attributesForOrgApiKey,
  contextWithAttributionBag,
  propagationHeaders,
  sanitizeAttribution,
} from "./attribution.js"

beforeAll(() => {
  propagation.setGlobalPropagator(new W3CBaggagePropagator())
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
    const actorTypes = [
      "user",
      "org_api_key",
      "oauth_client",
      "webhook",
      "job",
    ] as const
    for (const actorType of actorTypes) {
      const attrs = sanitizeAttribution({
        "ctxpipe.actor.type": actorType,
        "enduser.id": actorType === "org_api_key" ? undefined : "user_1",
        secret: "nope",
      } as never)
      expect(attrs["ctxpipe.actor.type"]).toBe(actorType)
      expect(attrs).not.toHaveProperty("secret")
    }
  })

  it("sends outgoing baggage from the attribution bag only", () => {
    let inbound = propagation.createBaggage()
    inbound = inbound.setEntry("enduser.id", { value: "spoofed" })
    inbound = inbound.setEntry("other", { value: "not-ours" })
    const parent = propagation.setBaggage(ROOT_CONTEXT, inbound)
    const { context: withBag, bag } = contextWithAttributionBag(parent)
    bag.set("enduser.id", "real")
    bag.set("ctxpipe.actor.type", "user")

    const headers = new Headers()
    propagationHeaders(headers, withBag)
    const baggage = headers.get("baggage") ?? ""
    expect(baggage).toContain("enduser.id=real")
    expect(baggage).toContain("ctxpipe.actor.type=user")
    expect(baggage).not.toContain("spoofed")
    expect(baggage).not.toContain("not-ours")
  })
})
