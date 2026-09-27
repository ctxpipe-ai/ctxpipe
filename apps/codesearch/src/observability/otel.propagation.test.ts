import { httpInstrumentationMiddleware } from "@hono/otel"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { codesearchSpanProcessors } from "./otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    ...codesearchSpanProcessors(),
    new SimpleSpanProcessor(exporter),
  ],
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

describe("incoming W3C context", () => {
  it("joins the caller trace and copies attribution baggage onto the span", async () => {
    const app = new Hono()
    app.use("*", httpInstrumentationMiddleware())
    app.get("/probe", (c) => c.text("ok"))

    const res = await app.request("http://codesearch.test/probe?token=SECRET", {
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        baggage: "ctxpipe.org.id=org_test,not.ours=drop-me",
      },
    })
    expect(res.status).toBe(200)

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name === "GET /probe")
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(span?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7")
    expect(span?.attributes["ctxpipe.org.id"]).toBe("org_test")
    expect(span?.attributes["not.ours"]).toBeUndefined()
    expect(span?.attributes["http.route"]).toBe("/probe")
    const url = String(span?.attributes["url.full"] ?? "")
    expect(url).not.toContain("?")
    expect(url).not.toContain("SECRET")
    expect(JSON.stringify(span?.attributes)).not.toContain("SECRET")
  })
})

describe("route template", () => {
  it("names the span from the route template, not the repository id", async () => {
    const app = new Hono()
    app.use("*", httpInstrumentationMiddleware())
    app.get("/repo/:repoId/files", (c) => c.text("ok"))

    const res = await app.request(
      "http://codesearch.test/repo/repo_abc123/files",
    )
    expect(res.status).toBe(200)

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name.startsWith("GET"))
    expect(span?.name).toBe("GET /repo/:repoId/files")
    expect(span?.attributes["http.route"]).toBe("/repo/:repoId/files")
    expect(span?.name.includes("repo_abc123")).toBe(false)
    expect(String(span?.attributes["http.route"]).includes("repo_abc123")).toBe(
      false,
    )
  })
})
