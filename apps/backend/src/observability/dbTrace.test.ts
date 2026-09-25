import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import type { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  instrumentPgClient,
  instrumentPgPool,
  serverAddressFromUrl,
  type TraceablePgClient,
  traceGraphQuery,
} from "./dbTrace.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
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

function argText(args: unknown[]): string {
  const first = args[0]
  if (typeof first === "string") return first
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof (first as { text?: unknown }).text === "string"
  ) {
    return (first as { text: string }).text
  }
  return ""
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
      password: "s3cret-password",
      connectionString:
        "postgres://user:s3cret-password@db.internal:5432/ctxpipe",
    },
    query: (...args: unknown[]) => {
      const text = argText(args)
      const last = args[args.length - 1]
      const pending = Promise.resolve().then(() => run(text))
      if (typeof last === "function") {
        const callback = last as (error: unknown, result?: unknown) => void
        pending.then(
          (result) => callback(undefined, result),
          (error: unknown) => callback(error),
        )
        return undefined
      }
      return pending
    },
  }
  instrumentPgClient(client)
  return client
}

function spanDump(spans: ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
    })),
  )
}

function duplicateKeyError(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "repositories_git_url_org_id_unique"',
    ),
    {
      code: "23505",
      detail:
        "Key (git_url, org_id)=(https://github.com/octocat/Spoon-Knife.git, org_secret) already exists.",
    },
  )
}

describe("postgres client spans", () => {
  it("parents queries to the active span and omits bound values", async () => {
    const secret = "repo_secret_value"
    const client = createClient(async () => ({ rows: [] }))
    const tracer = trace.getTracer("ctxpipe-backend")
    await tracer.startActiveSpan("POST /repositories", async (request) => {
      await client.query({
        text: 'select "id" from "organizations" where "slug" = $1',
        values: [secret],
      })
      request.end()
    })

    const spans = exporter.getFinishedSpans()
    const query = spans.find((span) => span.name === "SELECT organizations")
    const request = spans.find((span) => span.name === "POST /repositories")
    expect(query?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId)
    expect(query?.attributes["db.system.name"]).toBe("postgresql")
    expect(query?.attributes["db.operation.name"]).toBe("SELECT")
    expect(query?.attributes["db.collection.name"]).toBe("organizations")
    expect(query?.attributes["db.namespace"]).toBe("ctxpipe")
    expect(query?.attributes["server.address"]).toBe("db.internal")
    expect(query?.attributes["server.port"]).toBe(5432)
    expect(query?.attributes["db.query.text"]).toBe(
      'select "id" from "organizations" where "slug" = $1',
    )
    expect(spanDump(spans)).not.toContain(secret)
    expect(spanDump(spans)).not.toContain("s3cret-password")
    expect(spanDump(spans)).not.toContain("postgres://")
  })

  it("records SQLSTATE 23505 on the failed query and the rolled-back transaction", async () => {
    const secret = "repo_secret_value"
    const client = createClient(async (text) => {
      if (text.includes("insert into")) throw duplicateKeyError()
      return { rows: [] }
    })
    const tracer = trace.getTracer("ctxpipe-backend")
    await tracer.startActiveSpan("POST /repositories", async (request) => {
      await client.query("begin")
      await expect(
        client.query(
          'insert into "repositories" ("git_url", "org_id") values ($1, $2)',
          [secret, "org_secret"],
        ),
      ).rejects.toMatchObject({ code: "23505" })
      await client.query("rollback")
      request.end()
    })

    const spans = exporter.getFinishedSpans()
    const request = spans.find((span) => span.name === "POST /repositories")
    const transaction = spans.find(
      (span) => span.name === "postgresql transaction",
    )
    const insert = spans.find((span) => span.name === "INSERT repositories")
    expect(transaction?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    )
    expect(insert?.parentSpanContext?.spanId).toBe(
      transaction?.spanContext().spanId,
    )
    expect(insert?.status.code).toBe(SpanStatusCode.ERROR)
    expect(insert?.attributes["db.response.status_code"]).toBe("23505")
    expect(insert?.attributes["db.query.text"]).toContain("$1")
    expect(transaction?.status.code).toBe(SpanStatusCode.ERROR)
    const dumped = spanDump(spans)
    expect(dumped).not.toContain(secret)
    expect(dumped).not.toContain("Spoon-Knife")
    expect(dumped).not.toContain("org_secret")
    expect(dumped).not.toContain("params:")
  })

  it("omits Drizzle params and pg detail from the span exception", async () => {
    const secret = "https://github.com/octocat/Spoon-Knife.git"
    const cause = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "repositories_git_url_org_id_unique"',
      ),
      {
        code: "23505",
        severity: "ERROR",
        detail: `Key (git_url, org_id)=(${secret}, org_secret) already exists.`,
        where: `Key (git_url)=(${secret})`,
        hint: "see detail",
        internalQuery: `insert into repositories values ('${secret}')`,
        schema: "public",
        table: "repositories",
        constraint: "repositories_git_url_org_id_unique",
        routine: "_bt_check_unique",
      },
    )
    const client = createClient(async () => {
      throw new Error(
        `Failed query: insert into "repositories" ("git_url") values ($1)\nparams: ${secret}`,
        { cause },
      )
    })
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await expect(
          client.query('insert into "repositories" ("git_url") values ($1)'),
        ).rejects.toThrow(/Failed query/)
        request.end()
      })
    const insert = exporter
      .getFinishedSpans()
      .find((span) => span.name === "INSERT repositories")
    expect(insert?.attributes["db.response.status_code"]).toBe("23505")
    expect(insert?.status.message).not.toContain("params:")
    expect(insert?.status.message).not.toContain(secret)
    const dumped = spanDump(exporter.getFinishedSpans())
    expect(dumped).not.toContain(secret)
    expect(dumped).not.toContain("org_secret")
    expect(dumped).not.toContain("params:")
    expect(cause.detail).toContain(secret)
  })

  it("strips drizzle params from the recorded exception", async () => {
    const client = createClient(async () => {
      throw Object.assign(
        new Error(
          'Failed query: insert into "repositories" values ($1)\nparams: repo_secret_value,org_secret',
        ),
        { code: "23505" },
      )
    })
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await expect(
          client.query('insert into "repositories" values ($1)'),
        ).rejects.toThrow(/Failed query/)
        request.end()
      })
    const insert = exporter
      .getFinishedSpans()
      .find((span) => span.name === "INSERT repositories")
    expect(insert?.attributes["db.response.status_code"]).toBe("23505")
    expect(spanDump(exporter.getFinishedSpans())).not.toContain(
      "repo_secret_value",
    )
  })

  it("nests savepoint queries under the transaction span", async () => {
    const client = createClient(async () => ({ rows: [] }))
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await client.query("begin")
        await client.query("savepoint sp1")
        await client.query('select "id" from "organizations" where "id" = $1', [
          "org_secret",
        ])
        await client.query("release savepoint sp1")
        await client.query("commit")
        request.end()
      })

    const spans = exporter.getFinishedSpans()
    const request = spans.find((span) => span.name === "request")
    const transaction = spans.find(
      (span) => span.name === "postgresql transaction",
    )
    const savepoint = spans.find((span) => span.name === "postgresql savepoint")
    const select = spans.find((span) => span.name === "SELECT organizations")
    expect(transaction?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    )
    expect(savepoint?.parentSpanContext?.spanId).toBe(
      transaction?.spanContext().spanId,
    )
    expect(select?.parentSpanContext?.spanId).toBe(
      savepoint?.spanContext().spanId,
    )
    expect(transaction?.status.code).not.toBe(SpanStatusCode.ERROR)
    expect(spanDump(spans)).not.toContain("org_secret")
  })

  it("keeps in-transaction queries parented when the active context is lost", async () => {
    const client = createClient(async () => ({ rows: [] }))
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await client.query("begin")
        await context.with(ROOT_CONTEXT, async () => {
          await client.query("select 1")
        })
        await client.query("commit")
        request.end()
      })
    const spans = exporter.getFinishedSpans()
    const transaction = spans.find(
      (span) => span.name === "postgresql transaction",
    )
    const select = spans.find((span) => span.name === "SELECT")
    expect(select?.parentSpanContext?.spanId).toBe(
      transaction?.spanContext().spanId,
    )
    expect(spans.filter((span) => span.parentSpanContext == null)).toHaveLength(
      1,
    )
  })

  it("does not start spans when nothing is already tracing", async () => {
    const client = createClient(async () => ({ rows: [] }))
    await client.query("begin")
    await client.query("select 1")
    await client.query("commit")
    await client.query('insert into "repositories" values ($1)', ["secret"])
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it("records a callback query error with SQLSTATE", async () => {
    const client = createClient(async (text) => {
      if (text.startsWith("insert")) throw duplicateKeyError()
      return { rows: [] }
    })
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await new Promise<void>((resolve, reject) => {
          client.query(
            'insert into "repositories" values ($1)',
            ["repo_secret_value"],
            (error: unknown) => {
              if (error) reject(error)
              else resolve()
            },
          )
        }).catch((error: unknown) => {
          expect(error).toMatchObject({ code: "23505" })
        })
        request.end()
      })
    const insert = exporter
      .getFinishedSpans()
      .find((span) => span.name === "INSERT repositories")
    expect(insert?.attributes["db.response.status_code"]).toBe("23505")
    expect(spanDump(exporter.getFinishedSpans())).not.toContain(
      "repo_secret_value",
    )
  })

  it("caps db.query.text", async () => {
    const client = createClient(async () => ({ rows: [] }))
    const text = `select ${"a".repeat(3000)}`
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await client.query(text)
        request.end()
      })
    const query = exporter
      .getFinishedSpans()
      .find((span) => span.name === "SELECT")
    expect(String(query?.attributes["db.query.text"])).toHaveLength(2048)
  })

  it("instruments a client checked out of the pool once", async () => {
    const client: TraceablePgClient = {
      database: "ctxpipe",
      connectionParameters: {
        host: "db.internal",
        port: 5432,
        database: "ctxpipe",
      },
      query: () => Promise.resolve({ rows: [] }),
    }
    const pool = {
      connect: () => Promise.resolve(client),
    }
    instrumentPgPool(pool as unknown as Pool)
    instrumentPgPool(pool as unknown as Pool)
    const checked = await pool.connect()
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await checked.query("select 1")
        request.end()
      })
    expect(
      exporter.getFinishedSpans().filter((span) => span.name === "SELECT"),
    ).toHaveLength(1)
  })

  it("ends an abandoned transaction when the client is released", async () => {
    const client = createClient(async () => ({ rows: [] }))
    let released = false
    client.release = () => {
      released = true
    }
    const pool = {
      connect: () => Promise.resolve(client),
    }
    instrumentPgPool(pool as unknown as Pool)
    const first = await pool.connect()
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request-a", async (request) => {
        await first.query("begin")
        first.release?.()
        request.end()
      })
    expect(released).toBe(true)
    const abandoned = exporter
      .getFinishedSpans()
      .find((span) => span.name === "postgresql transaction")
    expect(abandoned).toBeDefined()

    exporter.reset()
    const second = await pool.connect()
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request-b", async (request) => {
        await second.query("select 1")
        request.end()
      })
    const spans = exporter.getFinishedSpans()
    const select = spans.find((span) => span.name === "SELECT")
    const request = spans.find((span) => span.name === "request-b")
    expect(select?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    )
    expect(spans.some((span) => span.name === "postgresql transaction")).toBe(
      false,
    )
  })
})

describe("graph query spans", () => {
  it("parents a FalkorDB query and does not record parameter values", async () => {
    const secret = "graph-param-secret"
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("GET /knowledge-graph", async (request) => {
        const value = await traceGraphQuery(
          {
            system: "falkordb",
            query: "MATCH (n:Repository) WHERE n.id = $id RETURN n",
            namespace: "org_1",
            serverAddress: "falkordb.internal",
            serverPort: 6379,
          },
          async () => secret,
        )
        expect(value).toBe(secret)
        request.end()
      })
    const spans = exporter.getFinishedSpans()
    const query = spans.find((span) => span.name === "MATCH Repository")
    const request = spans.find((span) => span.name === "GET /knowledge-graph")
    expect(query?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId)
    expect(query?.attributes["db.system.name"]).toBe("falkordb")
    expect(query?.attributes["db.operation.name"]).toBe("MATCH")
    expect(query?.attributes["db.collection.name"]).toBe("Repository")
    expect(query?.attributes["db.query.text"]).toBe(
      "MATCH (n:Repository) WHERE n.id = $id RETURN n",
    )
    expect(spanDump(spans)).not.toContain(secret)
  })

  it("does not start a graph span without an active parent", async () => {
    await traceGraphQuery(
      {
        system: "falkordb",
        query: "MATCH (n:Repository) RETURN n",
      },
      async () => undefined,
    )
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })
})

describe("serverAddressFromUrl", () => {
  it("keeps the host and drops userinfo", () => {
    expect(
      serverAddressFromUrl("redis://default:s3cret-password@falkordb:6379"),
    ).toEqual({ address: "falkordb", port: 6379 })
  })
})
