import { SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { serverAddressFromUrl, traceGraphQuery } from "./dbTrace.js"

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

  it("records SQLSTATE on a failed graph query", async () => {
    const cause = Object.assign(new Error("graph down"), { code: "08006" })
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("GET /knowledge-graph", async (request) => {
        await expect(
          traceGraphQuery(
            { system: "falkordb", query: "MATCH (n:Repository) RETURN n" },
            async () => {
              throw cause
            },
          ),
        ).rejects.toBe(cause)
        request.end()
      })
    const query = exporter
      .getFinishedSpans()
      .find((span) => span.name === "MATCH Repository")
    expect(query?.status.code).toBe(SpanStatusCode.ERROR)
    expect(query?.attributes["db.response.status_code"]).toBe("08006")
    expect(query?.attributes["error.type"]).toBe("08006")
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
