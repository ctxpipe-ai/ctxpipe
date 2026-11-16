import { describe, expect, it } from "vitest"

import { getServerApiHeaders } from "./api-headers.server"
import { duringServerRequest } from "./server-request-test"

function headersDuring(incoming: Record<string, string>): Promise<HeadersInit> {
  return duringServerRequest(incoming, async () => getServerApiHeaders())
}

describe("getServerApiHeaders", () => {
  it("forwards the document traceparent so server-render calls join its trace", async () => {
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    expect(
      await headersDuring({
        cookie: "session=abc",
        traceparent,
        tracestate: "vendor=1",
        "x-request-id": "doc_1",
      }),
    ).toEqual({ cookie: "session=abc", traceparent })
  })

  it("forwards the client address headers, so that the backend rate limits each browser and not the UI server", async () => {
    expect(
      await headersDuring({
        cookie: "session=abc",
        "x-forwarded-for": "198.51.100.66, 203.0.113.10",
        "x-real-ip": "203.0.113.10",
      }),
    ).toEqual({
      cookie: "session=abc",
      "x-forwarded-for": "198.51.100.66, 203.0.113.10",
      "x-real-ip": "203.0.113.10",
    })
  })

  it("returns no headers outside a request", () => {
    expect(getServerApiHeaders()).toEqual({})
  })
})
