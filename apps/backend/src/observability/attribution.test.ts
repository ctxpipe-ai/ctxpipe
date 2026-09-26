import { propagation, ROOT_CONTEXT } from "@opentelemetry/api"
import { W3CBaggagePropagator } from "@opentelemetry/core"
import { beforeAll, describe, expect, it } from "vitest"
import {
  baggageWithAttribution,
  contextWithAttributionBag,
} from "./attribution.js"

beforeAll(() => {
  propagation.setGlobalPropagator(new W3CBaggagePropagator())
})

describe("attribution attributes", () => {
  it("sends outgoing baggage from the attribution bag only", () => {
    let inbound = propagation.createBaggage()
    inbound = inbound.setEntry("enduser.id", { value: "spoofed" })
    inbound = inbound.setEntry("other", { value: "not-ours" })
    const parent = propagation.setBaggage(ROOT_CONTEXT, inbound)
    const { context: withBag, bag } = contextWithAttributionBag(parent)
    bag.set("enduser.id", "real")
    bag.set("ctxpipe.actor.type", "user")

    const headers = new Headers()
    propagation.inject(baggageWithAttribution(withBag), headers, {
      set(carrier, key, value) {
        carrier.set(key, value)
      },
    })
    const baggage = headers.get("baggage") ?? ""
    expect(baggage).toContain("enduser.id=real")
    expect(baggage).toContain("ctxpipe.actor.type=user")
    expect(baggage).not.toContain("spoofed")
    expect(baggage).not.toContain("not-ours")
  })
})
