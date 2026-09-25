import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OTEL_PROXY_MAX_BODY_BYTES } from "./otelBrowserConfig"
import { proxyBrowserOtlp } from "./otelBrowserProxy"

describe("proxyBrowserOtlp", () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://127.0.0.1:9/v1/traces"
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=test-ingest"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
  })

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    vi.unstubAllGlobals()
  })

  it("404s when browser OTEL is disabled", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/logs", { method: "POST" }),
    )
    expect(response.status).toBe(404)
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
      new Request("https://app.example/.otel/v1/logs", {
        method: "POST",
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
      new Request("https://app.example/.otel/v1/metrics", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("forwards POST /v1/logs with server ingest headers and Content-Encoding", async () => {
    const response = await proxyBrowserOtlp(
      new Request("https://app.example/.otel/v1/logs?x=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          "Content-Encoding": "gzip",
          Authorization: "browser-should-not-forward",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? []
    expect(url).toBe("http://127.0.0.1:9/v1/logs?x=1")
    const headers = new Headers(init?.headers)
    expect(init?.method).toBe("POST")
    expect(headers.get("authorization")).toBe("test-ingest")
    expect(headers.get("Content-Encoding")).toBe("gzip")
    expect(headers.get("Content-Type")).toBe("application/x-protobuf")
    expect(headers.get("Authorization")).not.toBe("browser-should-not-forward")
  })
})
