import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { toOTLPLogRecord } from "evlog/otlp"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import { applyLogContract, stripLogPii } from "./logContract.js"
import { applyRedactedSecretPaths } from "./secretPath.js"

function drizzleDuplicateKeyError(): Error {
  const cause = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "repositories_git_url_org_id_unique"',
    ),
    {
      severity: "ERROR",
      code: "23505",
      detail:
        "Key (git_url, org_id)=(https://github.com/octocat/Spoon-Knife.git, org_secret) already exists.",
      hint: "Use the existing row",
      where: "Key (git_url)=(https://github.com/octocat/Spoon-Knife.git)",
      internalQuery:
        "insert into repositories values ('https://github.com/octocat/Spoon-Knife.git')",
      schema: "public",
      table: "repositories",
      constraint: "repositories_git_url_org_id_unique",
      routine: "_bt_check_unique",
      file: "nbtinsert.c",
    },
  )
  return new Error(
    'Failed query: insert into "repositories" ("git_url") values ($1)\nparams: https://github.com/octocat/Spoon-Knife.git',
    { cause },
  )
}

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

  it("redacts secret paths nested in requestLogs", () => {
    const token = "RVPATHPROBELIVE1790331095NOTASECRET"
    const invitationId = "inv_liveprobe_notreal"
    const event: Record<string, unknown> = {
      path: `/.auth/api/v1/auth/reset-password/${token}`,
      requestLogs: [
        {
          level: "warn",
          message: {
            step: "oauth.endpoint_error",
            path: `/.auth/api/v1/auth/reset-password/${token}`,
            url: `https://backend.example/.auth/api/v1/public/invitations/${invitationId}`,
          },
        },
      ],
    }
    applyLogContract(event)
    expect(event.path).toBe("/.auth/api/v1/auth/reset-password/{token}")
    const nested = (
      event.requestLogs as {
        message: { path: string; url: string }
      }[]
    )[0]
    expect(nested?.message.path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(nested?.message.url).toBe(
      "https://backend.example/.auth/api/v1/public/invitations/{invitation}",
    )
    expect(JSON.stringify(event)).not.toContain(token)
    expect(JSON.stringify(event)).not.toContain(invitationId)
  })

  it("redacts a nested requestLogs path accumulated during the request", async () => {
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
    const token = "RVPATHPROBELIVE1790331095NOTASECRET"
    app.get("/.auth/api/v1/auth/reset-password/:token", (c) => {
      c.get("log").warn("Better Auth endpoint returned an error response", {
        step: "oauth.endpoint_error",
        path: c.req.path,
      })
      return c.json({ ok: false }, 400)
    })
    const res = await app.request(
      `http://backend.test/.auth/api/v1/auth/reset-password/${token}`,
    )
    expect(res.status).toBe(400)
    expect(events).toHaveLength(1)
    expect(events[0]?.path).toBe("/.auth/api/v1/auth/reset-password/{token}")
    expect(JSON.stringify(events[0])).not.toContain(token)
  })

  it("redacts a copy and leaves caller objects, frozen nodes, and typed arrays alone", () => {
    const token = "RVPATHPROBELIVE1790331095NOTASECRET"
    const secretPath = `/.auth/api/v1/auth/reset-password/${token}`
    const shared = { path: secretPath }
    const frozen = Object.freeze({ path: secretPath, note: "keep" })
    const getterOnly = {}
    Object.defineProperty(getterOnly, "path", {
      enumerable: true,
      get() {
        return secretPath
      },
    })
    const throwing = {}
    Object.defineProperty(throwing, "path", {
      enumerable: true,
      get() {
        throw new Error("unreadable")
      },
    })
    const bytes = new Uint8Array(5 * 1024 * 1024)
    const started = performance.now()
    const event: Record<string, unknown> = {
      path: secretPath,
      shared,
      frozen,
      getterOnly,
      throwing,
      bytes,
      requestLogs: [{ message: { path: secretPath } }],
    }
    applyRedactedSecretPaths(event)
    expect(performance.now() - started).toBeLessThan(250)
    expect(shared.path).toBe(secretPath)
    expect(frozen.path).toBe(secretPath)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(event.shared).not.toBe(shared)
    expect((event.shared as { path: string }).path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(event.frozen).not.toBe(frozen)
    expect((event.frozen as { path: string }).path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect((event.getterOnly as { path: string }).path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect((event.throwing as { path: string }).path).toBe("[redacted]")
    expect(event.bytes).toBe(bytes)
    expect(
      (event.requestLogs as { message: { path: string } }[])[0]?.message.path,
    ).toBe("/.auth/api/v1/auth/reset-password/{token}")
    expect(
      JSON.stringify({ path: event.path, shared: event.shared }),
    ).not.toContain(token)
  })

  it("does not rewrite the caller's object when the request log is emitted", async () => {
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
    const token = "RVPATHPROBELIVE1790331095NOTASECRET"
    const shared = {
      path: `/.auth/api/v1/auth/reset-password/${token}`,
    }
    app.get("/probe", (c) => {
      c.get("log").set({ details: shared })
      return c.json({ ok: true })
    })
    const res = await app.request("http://backend.test/probe")
    expect(res.status).toBe(200)
    expect(shared.path).toContain(token)
    expect(events[0]?.details).not.toBe(shared)
    expect((events[0]?.details as { path: string }).path).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(JSON.stringify(events[0])).not.toContain(token)
  })

  it("strips Drizzle params and pg detail from a copied error", () => {
    const error = drizzleDuplicateKeyError()
    const cause = error.cause as Error & { detail: string }
    const event: Record<string, unknown> = {
      step: "repositories.create",
      hint: "read the docs",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause,
      },
    }
    applyLogContract(event)
    expect(cause.detail).toContain("Spoon-Knife")
    const emitted = event.error as {
      message: string
      cause: Record<string, unknown>
    }
    expect(emitted.message).toContain("Failed query:")
    expect(emitted.message).not.toContain("params:")
    expect(emitted.cause.code).toBe("23505")
    expect(emitted.cause.severity).toBe("ERROR")
    expect(emitted.cause.schema).toBe("public")
    expect(emitted.cause.table).toBe("repositories")
    expect(emitted.cause.constraint).toBe("repositories_git_url_org_id_unique")
    expect(emitted.cause.routine).toBe("_bt_check_unique")
    expect(emitted.cause.detail).toBeUndefined()
    expect(emitted.cause.hint).toBeUndefined()
    expect(emitted.cause.where).toBeUndefined()
    expect(emitted.cause.internalQuery).toBeUndefined()
    expect(event.hint).toBe("read the docs")
    expect(JSON.stringify(event)).not.toContain("Spoon-Knife")
    expect(JSON.stringify(event)).not.toContain("org_secret")
    expect(JSON.stringify(event)).not.toContain("params:")
  })
})
