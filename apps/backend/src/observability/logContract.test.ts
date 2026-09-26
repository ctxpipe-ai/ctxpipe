import { context, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { contextWithAttributionBag } from "./attribution.js"
import { applyLogContract } from "./logContract.js"
import {
  createLogger,
  flushEvlog,
  getLogger,
  initEvlog,
  log,
  withLogger,
} from "./logger.js"
import { dbErrorException } from "./scrubDbError.js"
import { redactSecretPath } from "./secretPath.js"

function drizzleDuplicateKeyError(): Error {
  const cause = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "repositories_git_url_org_id_unique"',
    ),
    {
      severity: "ERROR",
      code: "23505",
      detail:
        "Key (git_url)=(https://github.com/octocat/Spoon-Knife.git, DETAILSECRET)",
      hint: "Use the existing row",
      where: "WHERESECRET",
      internalQuery: "insert into repositories values ('DETAILSECRET')",
      parameters: ["PARAMSECRET"],
      schema: "public",
      table: "repositories",
      constraint: "repositories_git_url_org_id_unique",
    },
  )
  return new Error(
    'Failed query: insert into "repositories" ("git_url") values ($1)\nparams: PARAMSECRET',
    { cause },
  )
}

describe("applyLogContract", () => {
  it("renames evlog http fields onto semantic convention keys", () => {
    const event: Record<string, unknown> = {
      method: "GET",
      path: "/health",
      status: 204,
      requestId: "req_alias",
      orgId: "org_1",
      orgSlug: "acme",
      userId: "user_1",
      environment: "pr-343",
      service: "backend",
    }
    applyLogContract(event, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    })
    expect(event["http.request.method"]).toBe("GET")
    expect(event["url.path"]).toBe("/health")
    expect(event["http.response.status_code"]).toBe(204)
    expect(event["request.id"]).toBe("req_alias")
    expect(event["ctxpipe.org.id"]).toBe("org_1")
    expect(event["ctxpipe.org.slug"]).toBe("acme")
    expect(event["enduser.id"]).toBe("user_1")
    expect(event.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(event.spanId).toBe("00f067aa0ba902b7")
    expect(event).not.toHaveProperty("method")
    expect(event).not.toHaveProperty("path")
    expect(event).not.toHaveProperty("status")
    expect(event).not.toHaveProperty("requestId")
    expect(event).not.toHaveProperty("orgId")
    expect(event).not.toHaveProperty("userId")
    expect(event).not.toHaveProperty("environment")
    expect(event).not.toHaveProperty("service")
    expect(event).not.toHaveProperty("service.namespace")
  })

  it("keeps a downstream status off the access-log key", () => {
    const downstream: Record<string, unknown> = {
      step: "repositoryDeletion.codesearch_purge",
      status: 502,
      "upstream.status_code": 502,
    }
    applyLogContract(downstream)
    expect(downstream.status).toBe(502)
    expect(downstream["upstream.status_code"]).toBe(502)
    expect(downstream).not.toHaveProperty("http.response.status_code")

    const access: Record<string, unknown> = {
      method: "POST",
      path: "/search",
      status: 400,
    }
    applyLogContract(access)
    expect(access["http.response.status_code"]).toBe(400)
    expect(access).not.toHaveProperty("status")
  })

  it("moves user.id onto enduser.id and leaves other user fields", () => {
    const event: Record<string, unknown> = {
      user: { id: "user_1", email: "ada@example.com" },
    }
    applyLogContract(event)
    expect(event["enduser.id"]).toBe("user_1")
    expect(event.user).toEqual({ email: "ada@example.com" })
  })
})

describe("span and db helpers kept for other lanes", () => {
  it("redacts credential path segments for span attributes", () => {
    expect(
      redactSecretPath("/.auth/api/v1/auth/reset-password/RESETTOKEN"),
    ).toBe("/.auth/api/v1/auth/reset-password/{token}")
    expect(
      redactSecretPath("/.auth/api/v1/public/invitations/inv_secret"),
    ).toBe("/.auth/api/v1/public/invitations/{invitation}")
  })

  it("drops Drizzle params from the span exception", () => {
    const sanitized = dbErrorException(drizzleDuplicateKeyError())
    expect(sanitized.message).toContain("Failed query:")
    expect(sanitized.message).not.toContain("PARAMSECRET")
    expect(sanitized.message).not.toContain("params:")
    expect(sanitized.cause).toBeUndefined()
  })
})

describe("evlog redact and OTLP drain", () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await flushEvlog()
    initEvlog({ silent: true })
  })

  function stubRuntimeEnv() {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
    )
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-at-least-32-characters")
  }

  it("redacts a Drizzle error, reset-password token, and query string in stdout and the drain", async () => {
    const token = "RESETTOKEN1790327887"
    const querySecret = "QUERYSECRET1790327887"
    const invitationId = "INVITESECRET1790327887"
    const bodies: unknown[] = []
    const seenHeaders: Array<string | null> = []
    const server = setupServer(
      http.post("http://127.0.0.1:4318/v1/logs", async ({ request }) => {
        seenHeaders.push(request.headers.get("x-test-otlp"))
        bodies.push(await request.json())
        return HttpResponse.json({})
      }),
    )
    server.listen({ onUnhandledRequest: "bypass" })
    const stdout: string[] = []
    const stderr: string[] = []
    const writeOut = process.stdout.write.bind(process.stdout)
    const writeErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      stdout.push(typeof chunk === "string" ? chunk : String(chunk))
      return writeOut(chunk as never, ...(rest as []))
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderr.push(typeof chunk === "string" ? chunk : String(chunk))
      return writeErr(chunk as never, ...(rest as []))
    }) as typeof process.stderr.write

    stubRuntimeEnv()
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "http://127.0.0.1:4318/v1/logs",
    )
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-test-otlp=probe-header")
    await flushEvlog()

    try {
      initEvlog()
      const app = new Hono<AppEnv>()
      app.use(evlog())
      app.get("/.auth/api/v1/auth/reset-password/:token", (c) => {
        c.get("log").set({
          url: c.req.url,
          email: "ada@example.com",
          user: { id: "user_1", email: "ada@example.com", name: "Ada" },
          invite: `https://backend.example/.auth/api/v1/public/invitations/${invitationId}`,
        })
        c.get("log").error(drizzleDuplicateKeyError())
        return c.json({ ok: false }, 400)
      })
      const res = await app.request(
        `http://backend.test/.auth/api/v1/auth/reset-password/${token}?reset_token=${querySecret}`,
      )
      expect(res.status).toBe(400)
      expect(bodies).toHaveLength(1)
      const printed = `${stdout.join("")}\n${stderr.join("")}`
      const payload = JSON.stringify(bodies[0])
      for (const secret of [
        token,
        querySecret,
        invitationId,
        "PARAMSECRET",
        "DETAILSECRET",
        "WHERESECRET",
        "ada@example.com",
        "params:",
      ]) {
        expect(printed).not.toContain(secret)
        expect(payload).not.toContain(secret)
      }
      expect(seenHeaders).toEqual(["probe-header"])
      const record = (
        bodies[0] as {
          resourceLogs: Array<{
            resource: {
              attributes: Array<{
                key: string
                value: { stringValue?: string }
              }>
            }
            scopeLogs: Array<{
              logRecords: Array<{ body: { stringValue: string } }>
            }>
          }>
        }
      ).resourceLogs[0]
      const body = JSON.parse(
        record?.scopeLogs[0]?.logRecords[0]?.body.stringValue ?? "{}",
      ) as Record<string, unknown>
      expect(body).not.toHaveProperty("environment")
      expect(body).not.toHaveProperty("service")
      expect(body["url.path"]).toBe(
        `/.auth/api/v1/auth/reset-password/[REDACTED]`,
      )
      expect(body["enduser.id"]).toBe("user_1")
      expect(String(body.url)).not.toContain("?")
      const resource = new Map(
        record?.resource.attributes.map((attribute) => [
          attribute.key,
          attribute.value.stringValue,
        ]),
      )
      expect(resource.get("service.name")).toBe("backend")
      expect(resource.get("service.namespace")).toBe("ctxpipe")
      expect(resource.get("deployment.environment")).toBe("development")
      const cause = (
        body.error as { cause?: { code?: string; detail?: string } }
      ).cause
      expect(cause?.code).toBe("23505")
      expect(cause?.detail).toBeUndefined()
    } finally {
      process.stdout.write = writeOut
      process.stderr.write = writeErr
      server.close()
    }
  })

  it("keeps a question mark in a message and strips queries from url and path values", async () => {
    stubRuntimeEnv()
    const stdout: string[] = []
    const writeOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      stdout.push(typeof chunk === "string" ? chunk : String(chunk))
      return writeOut(chunk as never, ...(rest as []))
    }) as typeof process.stdout.write
    await flushEvlog()
    try {
      initEvlog()
      log.info({
        message: "what is ctx?pipe",
        url: "https://backend.example/search?q=QUERYSECRET",
        "url.full": "http://backend.example/search?q=FULLSECRET",
        path: "/search?q=PATHSECRET",
      })
      const event = JSON.parse(stdout.join("")) as Record<string, unknown>
      expect(event.message).toBe("what is ctx?pipe")
      expect(event.url).toBe("https://backend.example/search[REDACTED]")
      expect(event["url.full"]).toBe("http://backend.example/search[REDACTED]")
      expect(event["url.path"]).toBe("/search[REDACTED]")
      expect(event).not.toHaveProperty("path")
    } finally {
      process.stdout.write = writeOut
    }
  })

  it("stamps traceId and request.id on a withLogger event", async () => {
    stubRuntimeEnv()
    const stdout: string[] = []
    const writeOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      stdout.push(typeof chunk === "string" ? chunk : String(chunk))
      return writeOut(chunk as never, ...(rest as []))
    }) as typeof process.stdout.write
    await flushEvlog()
    const provider = new NodeTracerProvider()
    provider.register({ propagator: null })
    const tracer = trace.getTracer("ctxpipe-test")
    try {
      initEvlog()
      const { context: attributed, bag } = contextWithAttributionBag(
        context.active(),
      )
      bag.set("request.id", "req_job")
      await context.with(attributed, () =>
        tracer.startActiveSpan("workflow", async (span) => {
          await withLogger(createLogger({}), async () => {
            getLogger().info("milestone")
          })
          const event = JSON.parse(
            stdout
              .join("")
              .split("\n")
              .find((line) => line.startsWith("{")) ?? "",
          ) as Record<string, unknown>
          expect(event.traceId).toBe(span.spanContext().traceId)
          expect(event.spanId).toBe(span.spanContext().spanId)
          expect(event["request.id"]).toBe("req_job")
          span.end()
        }),
      )
    } finally {
      process.stdout.write = writeOut
      context.disable()
      trace.disable()
      await provider.shutdown()
    }
  })

  it("puts the active span on a standalone log.warn OTLP record", async () => {
    stubRuntimeEnv()
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "http://127.0.0.1:4318/v1/logs",
    )
    const bodies: unknown[] = []
    const server = setupServer(
      http.post("http://127.0.0.1:4318/v1/logs", async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({})
      }),
    )
    server.listen({ onUnhandledRequest: "bypass" })
    await flushEvlog()
    const provider = new NodeTracerProvider()
    provider.register({ propagator: null })
    const tracer = trace.getTracer("ctxpipe-test")
    try {
      initEvlog()
      await tracer.startActiveSpan("advisor", async (span) => {
        log.warn({
          step: "advisor.code_search.rejected",
          message: "what is ctx?pipe",
        })
        await flushEvlog()
        expect(bodies).toHaveLength(1)
        const record = (
          bodies[0] as {
            resourceLogs: Array<{
              scopeLogs: Array<{
                logRecords: Array<{
                  traceId?: string
                  spanId?: string
                  body: { stringValue: string }
                }>
              }>
            }>
          }
        ).resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
        expect(record?.traceId).toBe(span.spanContext().traceId)
        expect(record?.spanId).toBe(span.spanContext().spanId)
        const body = JSON.parse(record?.body.stringValue ?? "{}") as Record<
          string,
          unknown
        >
        expect(body.message).toBe("what is ctx?pipe")
        expect(body.traceId).toBe(span.spanContext().traceId)
        span.end()
      })
    } finally {
      server.close()
      context.disable()
      trace.disable()
      await provider.shutdown()
    }
  })
})
