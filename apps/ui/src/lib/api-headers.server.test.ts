import { requestHandler } from "@tanstack/react-start/server"
import { describe, expect, it } from "vitest"
import { getServerApiHeaders } from "./api-headers.server"

async function headersDuring(
  incoming: Record<string, string>,
): Promise<HeadersInit> {
  const handle = requestHandler(() =>
    Response.json(getServerApiHeaders() as Record<string, string>),
  )
  const response = await handle(
    new Request("http://ui.railway.internal:3002/onboarding", {
      headers: incoming,
    }),
    {},
  )
  return (await response.json()) as HeadersInit
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

  it("returns no headers outside a request", () => {
    expect(getServerApiHeaders()).toEqual({})
  })
})
