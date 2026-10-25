import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api"
import { W3CBaggagePropagator } from "@opentelemetry/core"
import { beforeAll, describe, expect, it } from "vitest"

import { recordSpans } from "../../test/spans.js"
import {
  applyAttribution,
  baggageWithAttribution,
  contextWithAttributionBag,
  contextWithForkedAttributionBag,
  readAttribution,
} from "./attribution.js"
import { createLogger, withLogger } from "./logger.js"

// Registers the tracer provider and its async context manager.
recordSpans()

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

  it("keeps entries of a forked bag out of the parent and sibling bags", async () => {
    const { context: parent, bag } = contextWithAttributionBag(ROOT_CONTEXT)
    bag.set("request.id", "req_1")
    const first = contextWithForkedAttributionBag(parent)
    const second = contextWithForkedAttributionBag(parent)

    await withLogger(createLogger({}), async () => {
      context.with(first, () => {
        applyAttribution({ "ctxpipe.mcp.call.id": "call_1" })
      })
    })

    expect(context.with(first, () => readAttribution())).toEqual({
      "request.id": "req_1",
      "ctxpipe.mcp.call.id": "call_1",
    })
    expect(context.with(second, () => readAttribution())).toEqual({
      "request.id": "req_1",
    })
    expect(Object.fromEntries(bag)).toEqual({ "request.id": "req_1" })
  })
})
