import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { config } from "dotenv"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { instrumentPgPool } from "./dbTrace.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

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

describe.skipIf(!connectionString)("postgres client spans", () => {
  let pool: Pool

  beforeAll(async () => {
    provider.register()
    pool = new Pool({ connectionString, max: 2 })
    instrumentPgPool(pool)
    instrumentPgPool(pool)
  })

  beforeEach(() => {
    exporter.reset()
  })

  afterAll(async () => {
    await pool.end()
    await provider.shutdown()
  })

  it("parents a parameterized pool query to the active span and omits bound values", async () => {
    const secret = "repo_secret_value"
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("POST /repositories", async (request) => {
        await pool.query({
          text: "select $1::text as slug",
          values: [secret],
        })
        request.end()
      })

    const spans = exporter.getFinishedSpans()
    const query = spans.find((span) => span.name === "SELECT")
    const request = spans.find((span) => span.name === "POST /repositories")
    expect(query?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId)
    expect(query?.attributes["db.system.name"]).toBe("postgresql")
    expect(query?.attributes["db.operation.name"]).toBe("SELECT")
    expect(query?.attributes["db.query.text"]).toBe("select $1::text as slug")
    expect(query?.attributes["db.namespace"]).toBeTruthy()
    expect(query?.attributes["server.address"]).toBeTruthy()
    const dumped = spanDump(spans)
    expect(dumped).not.toContain(secret)
    expect(dumped).not.toContain("postgres://")
  })

  it("strips leading comments, caps query text, and skips queries with no active span", async () => {
    await pool.query("select 1")
    expect(exporter.getFinishedSpans()).toHaveLength(0)

    const text = `/* lead */\nselect ${"a".repeat(3000)}`
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("request", async (request) => {
        await pool.query(text).catch(() => undefined)
        request.end()
      })
    const query = exporter
      .getFinishedSpans()
      .find((span) => span.name === "SELECT")
    const stored = String(query?.attributes["db.query.text"])
    expect(stored.startsWith("select ")).toBe(true)
    expect(stored).toHaveLength(2048)
    expect(stored).not.toContain("/* lead */")
  })

  it("records SQLSTATE on a real unique violation and parents begin, insert, and rollback to the request", async () => {
    const secret = `obs-e-${Date.now()}-secret`
    const client = await pool.connect()
    try {
      await trace
        .getTracer("ctxpipe-backend")
        .startActiveSpan("POST /repositories", async (request) => {
          await client.query("begin")
          await client.query(
            "create temp table obs_e_lane (id int primary key, note text)",
          )
          await client.query(
            "insert into obs_e_lane (id, note) values ($1, $2)",
            [1, secret],
          )
          await expect(
            client.query("insert into obs_e_lane (id, note) values ($1, $2)", [
              1,
              secret,
            ]),
          ).rejects.toMatchObject({ code: "23505" })
          await client.query("rollback")
          request.end()
        })
    } finally {
      client.release()
    }

    const spans = exporter.getFinishedSpans()
    const request = spans.find((span) => span.name === "POST /repositories")
    const parent = request?.spanContext().spanId
    const begin = spans.find((span) => span.name === "BEGIN")
    const insert = spans.filter((span) => span.name === "INSERT obs_e_lane")
    const rollback = spans.find((span) => span.name === "ROLLBACK")
    expect(spans.some((span) => span.name === "postgresql transaction")).toBe(
      false,
    )
    expect(begin?.parentSpanContext?.spanId).toBe(parent)
    expect(rollback?.parentSpanContext?.spanId).toBe(parent)
    expect(insert).toHaveLength(2)
    for (const span of insert) {
      expect(span.parentSpanContext?.spanId).toBe(parent)
      expect(span.attributes["db.query.text"]).toContain("$1")
      expect(span.attributes["db.collection.name"]).toBe("obs_e_lane")
    }
    const failed = insert.find(
      (span) => span.attributes["db.response.status_code"] === "23505",
    )
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR)
    expect(failed?.attributes["error.type"]).toBe("23505")
    const dumped = spanDump(spans)
    expect(dumped).not.toContain(secret)
    expect(dumped).not.toContain("params:")
  })
})
