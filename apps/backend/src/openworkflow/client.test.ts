import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

const { runWorkflow } = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/ctxpipe"
  return { runWorkflow: vi.fn() }
})

vi.mock("openworkflow", () => ({
  OpenWorkflow: class {
    runWorkflow = runWorkflow
  },
}))

vi.mock("openworkflow/postgres", () => ({
  BackendPostgres: {
    connect: vi.fn(async () => ({})),
  },
}))

import { runWorkflowWithWorkerWake } from "./client.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
  runWorkflow.mockReset()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("runWorkflowWithWorkerWake", () => {
  it("does not start a span when nothing is already tracing", async () => {
    runWorkflow.mockResolvedValue({ id: "run_1" })
    await runWorkflowWithWorkerWake(
      { name: "repository-ingestion" },
      { orgId: "org_1" },
    )
    expect(runWorkflow).toHaveBeenCalledTimes(1)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it("parents an enqueue span to the active span", async () => {
    runWorkflow.mockResolvedValue({ id: "run_1" })
    await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("POST /repositories", async (request) => {
        await runWorkflowWithWorkerWake(
          { name: "repository-ingestion" },
          { orgId: "org_1" },
        )
        request.end()
      })
    const spans = exporter.getFinishedSpans()
    const request = spans.find((span) => span.name === "POST /repositories")
    const enqueue = spans.find(
      (span) => span.name === "openworkflow.enqueue repository-ingestion",
    )
    expect(enqueue?.kind).toBe(SpanKind.PRODUCER)
    expect(enqueue?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    )
    expect(enqueue?.attributes["db.system.name"]).toBe("postgresql")
    expect(enqueue?.attributes["db.operation.name"]).toBe("enqueue")
    expect(enqueue?.status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it("marks the enqueue span as an error and keeps bound values out of it", async () => {
    const secret = "https://github.com/octocat/Spoon-Knife.git"
    runWorkflow.mockRejectedValue(
      new Error(
        `Failed query: insert into workflow_runs values ($1)\nparams: ${secret}`,
      ),
    )
    await expect(
      trace.getTracer("ctxpipe-backend").startActiveSpan("request", (request) =>
        runWorkflowWithWorkerWake(
          { name: "repository-ingestion" },
          { orgId: "org_1" },
        ).finally(() => {
          request.end()
        }),
      ),
    ).rejects.toThrow(/Failed query/)
    const enqueue = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.enqueue repository-ingestion")
    expect(enqueue?.status.code).toBe(SpanStatusCode.ERROR)
    expect(enqueue?.status.message).not.toContain("params:")
    expect(
      JSON.stringify({
        attributes: enqueue?.attributes,
        status: enqueue?.status,
        events: enqueue?.events,
      }),
    ).not.toContain(secret)
  })
})
