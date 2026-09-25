import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { toOTLPLogRecord } from "evlog/otlp"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import { applyLogContract, stripLogPii } from "./logContract.js"

function walkKeys(value: unknown, keys: string[] = []): string[] {
  if (!value || typeof value !== "object") return keys
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, keys)
    return keys
  }
  for (const [key, child] of Object.entries(value)) {
    keys.push(key)
    walkKeys(child, keys)
  }
  return keys
}

describe("log contract", () => {
  it("strips email, name, and ip keys", () => {
    const event: Record<string, unknown> = {
      userId: "user_1",
      user: { id: "user_1", email: "ada@example.com", name: "Ada" },
      session: { id: "sess_1", ipAddress: "203.0.113.4", userAgent: "Mozilla" },
      userAgent: "Mozilla",
    }
    stripLogPii(event)
    applyLogContract(event, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    })
    const keys = walkKeys(event)
    expect(keys).not.toContain("email")
    expect(keys).not.toContain("ipAddress")
    expect(keys).not.toContain("userAgent")
    expect(keys).not.toContain("user-agent")
    expect(event["enduser.id"]).toBe("user_1")
    expect(event).not.toHaveProperty("userId")
    expect(event.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(event.spanId).toBe("00f067aa0ba902b7")
    expect(event["service.namespace"]).toBe("ctxpipe")
  })

  it("puts traceId on the OTLP log record, not only attributes", () => {
    const event = {
      timestamp: new Date().toISOString(),
      level: "info" as const,
      service: "ctxpipe-backend",
      environment: "pr-343",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      "request.id": "req_1",
      "enduser.id": "user_1",
    }
    const record = toOTLPLogRecord(event)
    expect(record.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(record.spanId).toBe("00f067aa0ba902b7")
    const attributeKeys = record.attributes.map((attribute) => attribute.key)
    expect(attributeKeys).toContain("request.id")
    expect(attributeKeys).toContain("enduser.id")
    expect(attributeKeys).not.toContain("traceId")
  })

  it("does not emit email or ip from a request log", async () => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    const events: Record<string, unknown>[] = []
    const app = new Hono<AppEnv>()
    app.use(
      evlog({
        enrich: (ctx) => {
          applyLogContract(ctx.event as Record<string, unknown>, {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
          })
        },
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch) {
            events.push(item.event as Record<string, unknown>)
          }
        },
      }),
    )
    app.get("/probe", (c) => {
      c.get("log").set({
        userId: "user_1",
        user: { id: "user_1", email: "ada@example.com", name: "Ada" },
        session: {
          id: "sess_1",
          ipAddress: "203.0.113.4",
          userAgent: "Mozilla",
        },
      })
      return c.json({ ok: true })
    })

    const res = await app.request("http://backend.test/probe", {
      headers: { "x-request-id": "req_log" },
    })
    expect(res.status).toBe(200)
    expect(events).toHaveLength(1)
    const keys = walkKeys(events[0])
    expect(keys).not.toContain("email")
    expect(keys).not.toContain("ipAddress")
    expect(keys).not.toContain("userAgent")
    expect(events[0]?.["request.id"]).toBe("req_log")
    expect(events[0]?.["enduser.id"]).toBe("user_1")
    expect(events[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(JSON.stringify(events[0])).not.toContain("ada@example.com")
    expect(JSON.stringify(events[0])).not.toContain("203.0.113.4")
  })

  it("redacts secret segments in the request log path", async () => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    const events: Record<string, unknown>[] = []
    const app = new Hono<AppEnv>()
    app.use(
      evlog({
        enrich: (ctx) => {
          applyLogContract(ctx.event as Record<string, unknown>)
        },
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch) {
            events.push(item.event as Record<string, unknown>)
          }
        },
      }),
    )
    app.get("/.auth/api/v1/auth/reset-password/:token", (c) =>
      c.json({ ok: true }),
    )
    app.get("/.auth/api/v1/public/invitations/:invitationId", (c) =>
      c.json({ ok: true }),
    )

    const token = "RVPATHPROBE1790327887NOTASECRET"
    const invitationId = "inv_secret_capability"
    await app.request(
      `http://backend.test/.auth/api/v1/auth/reset-password/${token}`,
    )
    await app.request(
      `http://backend.test/.auth/api/v1/public/invitations/${invitationId}`,
    )

    expect(events.map((event) => event.path)).toEqual([
      "/.auth/api/v1/auth/reset-password/{token}",
      "/.auth/api/v1/public/invitations/{invitation}",
    ])
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(invitationId)
  })
})
