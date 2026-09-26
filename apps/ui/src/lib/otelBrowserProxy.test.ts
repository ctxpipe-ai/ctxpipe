import { gzipSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OTEL_PROXY_MAX_BODY_BYTES } from "./otelBrowserConfig"
import {
  otelBrowserProxyRateBucketCountForTests,
  proxyBrowserOtlp,
  resetOtelBrowserProxyRateLimitForTests,
  setOtelBrowserProxyRateBucketCapForTests,
} from "./otelBrowserProxy"

function sameOriginRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (!headers.has("origin")) headers.set("origin", new URL(url).origin)
  return new Request(url, { ...init, headers })
}

/** Browser hit the public backend; the UI process sees its private host. */
function proxiedUiRequest(init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set("x-forwarded-host", "backend-pr-343.up.railway.app")
  headers.set("x-forwarded-proto", "https")
  if (!headers.has("origin")) {
    headers.set("origin", "https://backend-pr-343.up.railway.app")
  }
  return new Request("http://ui.railway.internal:3002/.otel/v1/traces", {
    method: "POST",
    ...init,
    headers,
  })
}

describe("proxyBrowserOtlp", () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://127.0.0.1:9/v1/traces"
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=test-ingest"
    process.env.RAILWAY_ENVIRONMENT_NAME = "pr-343"
    resetOtelBrowserProxyRateLimitForTests()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
  })

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    delete process.env.RAILWAY_ENVIRONMENT_NAME
    vi.unstubAllGlobals()
  })

  it("returns 204 when browser OTEL is disabled", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/logs", {
        method: "POST",
        body: "{}",
      }),
    )
    expect(response.status).toBe(204)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("405s GET on an allowed signal path", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/logs", { method: "GET" }),
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("POST")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("404s POST to a path outside the signal allowlist", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/other", {
        method: "POST",
        body: "{}",
      }),
    )
    expect(response.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("404s from the router pathname when request.url is an allowed signal", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://collector.internal/v1/traces", {
        method: "POST",
        body: "{}",
      }),
      "/.otel/v1/other",
    )
    expect(response.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("404s bare /.otel and other non-signal paths from the router pathname", async () => {
    for (const pathname of ["/.otel", "/.otel/not-a-signal"]) {
      const response = await proxyBrowserOtlp(
        new Request("https://collector.internal/v1/traces", {
          method: "POST",
          body: "{}",
        }),
        pathname,
      )
      expect(response.status).toBe(404)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns 502 when the collector closes the socket", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error("The socket connection was closed unexpectedly."),
    )
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(502)
  })

  it("413s a body over 1 MiB from Content-Length without forwarding", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/logs", {
        method: "POST",
        headers: {
          "Content-Length": String(OTEL_PROXY_MAX_BODY_BYTES + 1),
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    )
    expect(response.status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("413s a streamed body over 1 MiB", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OTEL_PROXY_MAX_BODY_BYTES + 8))
        controller.close()
      },
    })
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("forwards scrubbed JSON and keeps the server ingest header", async () => {
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/logs?x=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "browser-should-not-forward",
        },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: "backend" },
                  },
                  {
                    key: "deployment.environment",
                    value: { stringValue: "production" },
                  },
                  {
                    key: "enduser.id",
                    value: { stringValue: "user_forged" },
                  },
                  {
                    key: "rum.sessionId",
                    value: { stringValue: "5abd8152fd3ba7e4f4436f9750f5442d" },
                  },
                ],
              },
              scopeSpans: [
                {
                  spans: [
                    {
                      name: "page_view",
                      attributes: [
                        {
                          key: "location.href",
                          value: {
                            stringValue:
                              "https://app.example/.auth/device?user_code=BADCODE",
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              resource: {
                attributes: [
                  {
                    key: "rum.sessionId",
                    value: { stringValue: "alice@example.com" },
                  },
                ],
              },
              scopeSpans: [],
            },
          ],
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? []
    expect(url).toBe("http://127.0.0.1:9/v1/logs")
    const headers = new Headers(init?.headers)
    expect(init?.method).toBe("POST")
    expect(headers.get("authorization")).toBe("test-ingest")
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(headers.get("Authorization")).not.toBe("browser-should-not-forward")
    const forwarded = JSON.parse(
      new TextDecoder().decode(init?.body as Uint8Array),
    )
    expect(
      forwarded.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value
        .stringValue,
    ).toBe("https://app.example/.auth/device")
    expect(forwarded.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "ui" } },
      { key: "service.namespace", value: { stringValue: "ctxpipe" } },
      { key: "deployment.environment", value: { stringValue: "pr-343" } },
      {
        key: "rum.sessionId",
        value: { stringValue: "5abd8152fd3ba7e4f4436f9750f5442d" },
      },
    ])
    expect(forwarded.resourceSpans[1].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "ui" } },
      { key: "service.namespace", value: { stringValue: "ctxpipe" } },
      { key: "deployment.environment", value: { stringValue: "pr-343" } },
    ])
  })

  it("rejects an empty non-JSON body before it can be forwarded", async () => {
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
      }),
    )
    expect(response.status).toBe(415)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects protobuf so an unscrubbed body is not forwarded", async () => {
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(response.status).toBe(415)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON after the body is read", async () => {
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    )
    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("answers an empty JSON body locally", async () => {
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    )
    expect(response.status).toBe(204)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects gzip instead of decompressing it", async () => {
    const body = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20))
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body,
      }),
    )
    expect(response.status).toBe(415)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects a cross-origin post", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: "{}",
      }),
    )
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns 429 after the per-IP burst", async () => {
    for (let index = 0; index < 60; index += 1) {
      const response = await proxyBrowserOtlp(
        sameOriginRequest("https://app.example/.otel/v1/traces", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.5",
          },
          body: "{}",
        }),
      )
      expect(response.status).toBe(200)
    }
    const blocked = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.5",
        },
        body: "{}",
      }),
    )
    expect(blocked.status).toBe(429)
  })

  it("evicts idle rate buckets and caps the map", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-25T00:00:00Z"))
    setOtelBrowserProxyRateBucketCapForTests(3)
    try {
      for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
        const response = await proxyBrowserOtlp(
          sameOriginRequest("https://app.example/.otel/v1/traces", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": ip,
            },
            body: "{}",
          }),
        )
        expect(response.status).toBe(200)
      }
      expect(otelBrowserProxyRateBucketCountForTests()).toBe(3)

      vi.setSystemTime(new Date("2026-09-25T00:01:01Z"))
      const idle = await proxyBrowserOtlp(
        sameOriginRequest("https://app.example/.otel/v1/traces", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.9",
          },
          body: "{}",
        }),
      )
      expect(idle.status).toBe(200)
      expect(otelBrowserProxyRateBucketCountForTests()).toBe(1)

      vi.setSystemTime(new Date("2026-09-25T00:02:00Z"))
      for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
        const response = await proxyBrowserOtlp(
          sameOriginRequest("https://app.example/.otel/v1/traces", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": ip,
            },
            body: "{}",
          }),
        )
        expect(response.status).toBe(200)
      }
      expect(otelBrowserProxyRateBucketCountForTests()).toBeLessThanOrEqual(3)
    } finally {
      setOtelBrowserProxyRateBucketCapForTests(10_000)
      vi.useRealTimers()
    }
  })

  it("returns 400 when the JSON nesting exceeds the scrub depth", async () => {
    let value: unknown = { stringValue: "https://app.example/a?token=1" }
    for (let depth = 0; depth < 40; depth += 1) {
      value = { arrayValue: { values: [value] } }
    }
    const response = await proxyBrowserOtlp(
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      name: "page_view",
                      attributes: [{ key: "location.href", value }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    )
    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("accepts the public origin when the request host is the private UI host", async () => {
    const response = await proxyBrowserOtlp(
      proxiedUiRequest({
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("rejects a foreign origin even when forwarded host is the public site", async () => {
    const response = await proxyBrowserOtlp(
      proxiedUiRequest({
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: "{}",
      }),
    )
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("accepts Origin that matches the request host when no forwarded host is set", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example",
        },
        body: "{}",
      }),
    )
    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("rejects gzip when the forwarded public origin is valid", async () => {
    const body = gzipSync(Buffer.alloc(64, 0x20))
    const response = await proxyBrowserOtlp(
      proxiedUiRequest({
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body,
      }),
    )
    expect(response.status).toBe(415)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("answers an empty body locally when the forwarded public origin is valid", async () => {
    const response = await proxyBrowserOtlp(
      proxiedUiRequest({
        headers: { "Content-Type": "application/json" },
      }),
    )
    expect(response.status).toBe(204)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns 400 for deep JSON when the forwarded public origin is valid", async () => {
    let value: unknown = { stringValue: "https://app.example/a?token=1" }
    for (let depth = 0; depth < 40; depth += 1) {
      value = { arrayValue: { values: [value] } }
    }
    const response = await proxyBrowserOtlp(
      proxiedUiRequest({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      name: "page_view",
                      attributes: [{ key: "location.href", value }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    )
    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns 429 after the burst when the forwarded public origin is valid", async () => {
    for (let index = 0; index < 60; index += 1) {
      const response = await proxyBrowserOtlp(
        proxiedUiRequest({
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.88",
          },
          body: "{}",
        }),
      )
      expect(response.status).toBe(200)
    }
    const blocked = await proxyBrowserOtlp(
      proxiedUiRequest({
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.88",
        },
        body: "{}",
      }),
    )
    expect(blocked.status).toBe(429)
  })
})
