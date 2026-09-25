import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import { backendOtelMiddleware } from "./http.js"
import { applyLogContract } from "./logContract.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
})

afterAll(async () => {
  await provider.shutdown()
})

describe("local attribution proof", () => {
  it("serves a real HTTP request with a continued trace and a correlated log", async () => {
    const events: Record<string, unknown>[] = []
    const app = new Hono<AppEnv>()
    app.use(
      evlog({
        enrich: (ctx) => {
          applyLogContract(ctx.event as Record<string, unknown>)
        },
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch)
            events.push(item.event as Record<string, unknown>)
        },
      }),
    )
    app.use("*", backendOtelMiddleware())
    app.get("/.auth/api/config", (c) => {
      c.get("log").set({
        user: { id: "user_1", email: "ada@example.com", name: "Ada" },
        session: {
          id: "sess_1",
          ipAddress: "203.0.113.9",
          userAgent: "Mozilla",
        },
      })
      return c.json({ ok: true })
    })

    const server = createServer(async (req, res) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value)
      }
      const response = await app.fetch(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
        }),
      )
      const body = Buffer.from(await response.arrayBuffer())
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(body)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const port = (server.address() as AddressInfo).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/.auth/api/config`, {
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-request-id": "req_local",
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-request-id")).toBe("req_local")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name.startsWith("GET"))
    const log = events[0]
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(span?.attributes["request.id"]).toBe("req_local")
    expect(log?.traceId).toBe(span?.spanContext().traceId)
    expect(log?.["request.id"]).toBe("req_local")
    expect(JSON.stringify(log)).not.toContain("ada@example.com")
    expect(JSON.stringify(log)).not.toContain("203.0.113.9")

    const proof = {
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
      spanName: span?.name,
      attributes: span?.attributes,
      requestIdHeader: "req_local",
      log: {
        traceId: log?.traceId,
        spanId: log?.spanId,
        "request.id": log?.["request.id"],
        "enduser.id": log?.["enduser.id"],
        environment: log?.environment,
        "service.namespace": log?.["service.namespace"],
        containsEmail: JSON.stringify(log).includes("ada@example.com"),
        containsIp: JSON.stringify(log).includes("203.0.113.9"),
      },
    }
    mkdirSync("/opt/cursor/artifacts/steps/attribution", { recursive: true })
    writeFileSync(
      "/opt/cursor/artifacts/steps/attribution/local-proof.json",
      JSON.stringify(proof, null, 2),
    )
  })
})
