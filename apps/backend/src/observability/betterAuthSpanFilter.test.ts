import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { BetterAuthSpanFilter } from "./betterAuthSpanFilter.js"
import { instrumentPgClient, type TraceablePgClient } from "./dbTrace.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new BetterAuthSpanFilter(new SimpleSpanProcessor(exporter))],
})

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
})

function names(spans: ReadableSpan[]): string[] {
  return spans.map((span) => span.name).sort()
}

function createClient(
  run: (text: string) => Promise<unknown>,
): TraceablePgClient {
  const client: TraceablePgClient = {
    database: "ctxpipe",
    connectionParameters: {
      host: "db.internal",
      port: 5432,
      database: "ctxpipe",
    },
    query: (text: unknown) => {
      const sql = typeof text === "string" ? text : ""
      return Promise.resolve().then(() => run(sql))
    },
  }
  instrumentPgClient(client)
  return client
}

describe("Better Auth span filter", () => {
  it("drops the session waterfall under POST /mcp and keeps attribution plus dbTrace", async () => {
    const client = createClient(async (text) => {
      if (text.includes('from "sessions"')) throw new Error("sessions down")
      return { rows: [] }
    })
    const server = trace.getTracer("ctxpipe-backend")
    const auth = trace.getTracer("better-auth")

    await server.startActiveSpan(
      "POST /mcp",
      {
        kind: SpanKind.SERVER,
        attributes: {
          "url.path": "/mcp",
          "request.id": "req_mcp",
        },
      },
      async (span) => {
        span.setAttribute("enduser.id", "user_mcp")
        span.setAttribute("ctxpipe.org.id", "org_mcp")
        span.setAttribute("ctxpipe.actor.type", "user")
        await auth.startActiveSpan("GET /get-session", async (endpoint) => {
          const adapter = auth.startSpan("db findOne sessions")
          adapter.setStatus({
            code: SpanStatusCode.ERROR,
            message: "adapter failed",
          })
          adapter.recordException(new Error("adapter failed"))
          adapter.end()
          auth.startSpan("hook after /get-session plugin:dash").end()
          auth.startSpan("hook before /get-session plugin:api-key").end()
          auth.startSpan("handler /get-session").end()
          endpoint.end()
        })
        await expect(
          client.query('select "id" from "sessions" where "token" = $1'),
        ).rejects.toThrow("sessions down")
        await client.query('select "id" from "users" where "id" = $1')
        span.end()
      },
    )

    const finished = exporter.getFinishedSpans()
    const mcp = finished.find((span) => span.name === "POST /mcp")
    expect(mcp?.attributes).toMatchObject({
      "request.id": "req_mcp",
      "enduser.id": "user_mcp",
      "ctxpipe.org.id": "org_mcp",
      "ctxpipe.actor.type": "user",
    })
    expect(names(finished)).toEqual([
      "POST /mcp",
      "SELECT sessions",
      "SELECT users",
    ])
    const sessions = finished.find((span) => span.name === "SELECT sessions")
    expect(sessions?.instrumentationScope.name).toBe("ctxpipe-backend")
    expect(sessions?.status.code).toBe(SpanStatusCode.ERROR)
    expect(finished.some((span) => span.name.startsWith("db "))).toBe(false)
    expect(finished.some((span) => span.name.startsWith("hook "))).toBe(false)
  })

  it("keeps auth endpoint spans that are the request and drops hooks and adapter spans", async () => {
    const server = trace.getTracer("ctxpipe-backend")
    const auth = trace.getTracer("better-auth")

    await server.startActiveSpan(
      "GET /.auth/api/v1/auth/get-session",
      {
        kind: SpanKind.SERVER,
        attributes: {
          "url.path": "/.auth/api/v1/auth/get-session",
        },
      },
      async (span) => {
        await auth.startActiveSpan("GET /get-session", async (endpoint) => {
          auth.startSpan("hook after /get-session plugin:dash").end()
          auth.startSpan("hook before /get-session plugin:bearer").end()
          auth.startSpan("hook after /get-session plugin:jwt").end()
          auth.startSpan("handler /get-session").end()
          const adapter = auth.startSpan("db findOne users")
          adapter.setStatus({ code: SpanStatusCode.ERROR })
          adapter.end()
          auth.startSpan("db findMany jwkss").end()
          auth.startSpan("onRequest oauth-provider").end()
          endpoint.end()
        })
        await auth.startActiveSpan("POST /sign-in/email", async (signIn) => {
          await auth.startActiveSpan("GET /get-session", async (nested) => {
            nested.end()
          })
          signIn.end()
        })
        auth.startSpan("POST /sign-up/email").end()
        auth.startSpan("GET /organization/get-full-organization").end()
        span.updateName("GET /.auth/api/*")
        span.end()
      },
    )

    expect(names(exporter.getFinishedSpans())).toEqual([
      "GET /.auth/api/*",
      "GET /get-session",
      "GET /organization/get-full-organization",
      "POST /sign-in/email",
      "POST /sign-up/email",
    ])
  })

  it("drops better-auth roots and leaves same-named server spans alone", async () => {
    const server = trace.getTracer("ctxpipe-backend")
    const auth = trace.getTracer("better-auth")

    await context.with(ROOT_CONTEXT, async () => {
      auth.startSpan("GET /get-session").end()
      auth.startSpan("hook after /get-session plugin:dash").end()
      const sameName = server.startSpan("hook after /get-session plugin:dash", {
        kind: SpanKind.INTERNAL,
      })
      sameName.end()
    })

    const finished = exporter.getFinishedSpans()
    expect(finished.map((span) => span.name)).toEqual([
      "hook after /get-session plugin:dash",
    ])
    expect(finished[0]?.instrumentationScope.name).toBe("ctxpipe-backend")
  })
})
