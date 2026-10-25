import { createServer } from "node:http"

import { context, propagation, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createLogger, withLogger } from "../observability/logger.js"
import {
  isViteHmrWebSocketRequest,
  proxyUiRequest,
  UI_PROXY_TIMEOUT_MS,
  uiProxyUpstreamHeaders,
} from "./ui.js"

describe("UI websocket proxy helpers", () => {
  it("detects vite websocket upgrades in development", () => {
    const request = new Request("http://localhost:3000/", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-hmr",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "development")).toBe(true)
  })

  it("detects vite ping websocket upgrades in development", () => {
    const request = new Request("http://localhost:3000/", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-ping",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "development")).toBe(true)
  })

  it("ignores non-vite websocket upgrades", () => {
    const request = new Request("http://localhost:3000/ws", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "graphql-ws",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "development")).toBe(false)
  })

  it("ignores websocket upgrades outside development", () => {
    const request = new Request("http://localhost:3000/", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-hmr",
      },
    })

    expect(isViteHmrWebSocketRequest(request, "production")).toBe(false)
  })
})

describe("UI HTTP proxy budget", () => {
  const trust = { publicOrigin: "http://localhost:3000" }
  it("returns 504 when the upstream hangs past the abort budget", async () => {
    expect(UI_PROXY_TIMEOUT_MS).toBe(15_000)

    const server = createServer(() => {
      // Intentionally never respond so the proxy abort budget fires.
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("expected a TCP listen address")
    }

    const started = Date.now()
    try {
      const response = await proxyUiRequest(
        new Request("http://localhost/ws/context"),
        `http://127.0.0.1:${address.port}`,
        50,
        trust,
      )
      expect(response.status).toBe(504)
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it("returns 502 when the upstream connection is refused", async () => {
    const response = await proxyUiRequest(
      new Request("http://localhost/ws/context"),
      "http://127.0.0.1:1",
      200,
      trust,
    )
    expect(response.status).toBe(502)
  })

  it("returns 502 when the upstream resets the connection", async () => {
    const server = createServer((req) => {
      req.socket.destroy()
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("expected a TCP listen address")
    }

    try {
      const response = await proxyUiRequest(
        new Request("http://localhost/ws/context"),
        `http://127.0.0.1:${address.port}`,
        200,
        trust,
      )
      expect(response.status).toBe(502)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})

describe("UI proxy redirects", () => {
  // A signed-out document request for an org page gets a server-render
  // redirect to sign-in. If the proxy follows it, the browser receives the
  // sign-in HTML at the org URL. The client router then renders the org
  // route over the sign-in markup: React error #418.
  it("passes a server-render redirect to the browser", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/acme") {
        res.writeHead(307, { location: "/.auth/sign-in" })
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html>sign in</html>")
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("expected a TCP listen address")
    }

    try {
      const response = await proxyUiRequest(
        new Request("http://localhost/acme"),
        `http://127.0.0.1:${address.port}`,
        1_000,
        { publicOrigin: "http://localhost:3000" },
      )
      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("/.auth/sign-in")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})

describe("UI proxy failure response", () => {
  const trust = { publicOrigin: "http://localhost:3000" }
  // `setup-evlog.ts` turns loggers into no-ops. Turn them on so the tests can
  // read the failure log, then put the setup config back.
  beforeAll(() => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
  })
  afterAll(() => {
    initLogger({
      enabled: false,
      env: { service: "ctxpipe-backend-test" },
    })
  })

  async function withHangingUpstream<T>(
    fn: (upstream: string) => Promise<T>,
  ): Promise<T> {
    const server = createServer(() => {
      // Never respond, so the proxy timeout fires.
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("expected a TCP listen address")
    }
    try {
      return await fn(`http://127.0.0.1:${address.port}`)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }

  it("logs a timeout and does not let a cache keep the 504", async () => {
    const logger = createLogger({ test: true })
    const response = await withHangingUpstream((upstream) =>
      withLogger(logger, () =>
        proxyUiRequest(
          new Request("http://localhost/acme/ws/docs"),
          upstream,
          50,
          trust,
        ),
      ),
    )
    expect(response.status).toBe(504)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("Gateway Timeout")
    expect(logger.getContext()).toMatchObject({
      uiProxy: { outcome: "timeout", timeoutMs: 50 },
    })
  })

  it("logs an upstream error and does not let a cache keep the 502", async () => {
    const logger = createLogger({ test: true })
    const response = await withLogger(logger, () =>
      proxyUiRequest(
        new Request("http://localhost/assets/app.js"),
        "http://127.0.0.1:1",
        200,
        trust,
      ),
    )
    expect(response.status).toBe(502)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("Bad Gateway")
    expect(logger.getContext()).toMatchObject({
      uiProxy: { outcome: "upstream_error" },
    })
  })

  it("still answers 502 when no request logger exists", async () => {
    const response = await proxyUiRequest(
      new Request("http://localhost/assets/app.js"),
      "http://127.0.0.1:1",
      200,
      trust,
    )
    expect(response.status).toBe(502)
  })
})

describe("uiProxyUpstreamHeaders", () => {
  it("replaces a spoofed forwarded host with the configured public host", () => {
    const headers = uiProxyUpstreamHeaders(
      new Headers({
        origin: "https://backend-pr-343.up.railway.app",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
      "ui.railway.internal:3002",
      { publicOrigin: "https://backend-pr-343.up.railway.app" },
    )
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-343.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
    expect(headers.get("host")).toBe("ui.railway.internal:3002")
    expect(headers.get("origin")).toBe("https://backend-pr-343.up.railway.app")
  })

  it("passes the document span to the UI server as traceparent", async () => {
    const provider = new NodeTracerProvider()
    provider.register()
    try {
      const span = provider.getTracer("test").startSpan("GET /*")
      const headers = context.with(trace.setSpan(context.active(), span), () =>
        uiProxyUpstreamHeaders(
          new Headers({
            traceparent: "not-a-traceparent",
            tracestate: "client=junk",
          }),
          "ui.railway.internal:3002",
          { publicOrigin: "https://backend-pr-343.up.railway.app" },
        ),
      )
      span.end()
      const { traceId, spanId } = span.spanContext()
      expect(headers.get("traceparent")).toBe(`00-${traceId}-${spanId}-01`)
      expect(headers.get("tracestate")).toBeNull()
    } finally {
      await provider.shutdown()
      trace.disable()
      context.disable()
      propagation.disable()
    }
  })

  it("uses the configured https origin without an Origin header", () => {
    const headers = uiProxyUpstreamHeaders(
      new Headers({ "x-forwarded-proto": "https" }),
      "ui.railway.internal:3002",
      { publicOrigin: "https://backend-pr-343.up.railway.app" },
    )
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-343.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
  })
})

describe("browser OTLP proxy headers", () => {
  const publicOrigin = "https://backend-pr-280.up.railway.app"
  const trust = { publicOrigin }

  it("does not trust a forged origin or forwarded host", () => {
    const headers = uiProxyUpstreamHeaders(
      new Headers({
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
      "ui.railway.internal:3002",
      trust,
    )
    expect(headers.get("origin")).toBe("https://evil.example")
    expect(headers.get("x-forwarded-host")).toBe(
      "backend-pr-280.up.railway.app",
    )
    expect(headers.get("x-forwarded-proto")).toBe("https")
  })
})
