import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import {
  capIngestText,
  INGEST_TELEMETRY_TEXT_MAX,
  startIngestModelCall,
  withIngestRunSpan,
  withIngestSpan,
} from "./ingest-telemetry.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
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

describe("ingest model call telemetry", () => {
  it("records one generation in the Langfuse session of the run, with usage and the step", () => {
    const call = startIngestModelCall(
      { runId: "run_1", shard: 3, step: "skill:repository:apis:ws_1" },
      "openai/gpt-5.6-terra",
    )
    call.finish({
      status: 200,
      durationMs: 42,
      finishReason: "stop",
      responseModel: "openai/gpt-5.6-terra-2026",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 },
    })
    // A second finish does not end the span again.
    call.finish({ status: 500, durationMs: 1 })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "openai/gpt-5.6-terra",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 10,
      "ctxpipe.ingest.run.id": "run_1",
      "ctxpipe.ingest.shard": "3",
      "ctxpipe.ingest.step": "skill:repository:apis:ws_1",
      "session.id": "ingest:run_1",
    })
    expect(spans[0]?.status.code).not.toBe(2)
  })

  it("holds no prompt or answer, and marks a server error", () => {
    const call = startIngestModelCall(
      { runId: "run_2", shard: 0, step: "s" },
      "m",
    )
    call.finish({ status: 502, durationMs: 5 })
    const span = exporter.getFinishedSpans()[0]
    expect(Object.keys(span?.attributes ?? {})).not.toEqual(
      expect.arrayContaining(["langfuse.observation.input"]),
    )
    expect(
      Object.keys(span?.attributes ?? {}).filter((key) =>
        /input$|output$|prompt|completion/.test(key.replace(/_tokens$/, "")),
      ),
    ).toEqual([])
    expect(span?.status.code).toBe(2)
  })
})

describe("capIngestText", () => {
  it("cuts a long text and keeps a short one", () => {
    expect(capIngestText("short")).toBe("short")
    const cut = capIngestText("x".repeat(5_000))
    expect(cut.length).toBe(INGEST_TELEMETRY_TEXT_MAX + 3)
    expect(capIngestText(`${"x".repeat(5000)}last error`)).toMatch(
      /last error$/,
    )
  })
})

describe("workflow control telemetry", () => {
  it("does not mark a parked step as an error", async () => {
    const signal = new Error("private sentinel")
    signal.name = "SleepSignalError"
    await expect(
      withIngestSpan("ingestion.step", {}, async () => {
        throw signal
      }),
    ).rejects.toBe(signal)
    expect(exporter.getFinishedSpans()[0]?.status.code).not.toBe(2)
  })
  it("exports only the terminal run execution", async () => {
    const signal = new Error("private sentinel")
    signal.name = "SleepSignalError"
    await expect(
      withIngestRunSpan({}, async () => {
        throw signal
      }),
    ).rejects.toBe(signal)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    await withIngestRunSpan({}, async () => "done")
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "ingestion.run",
    ])
  })
  it("does not export an arbitrary error name or message", async () => {
    const error = new Error("private sentinel")
    error.name = "private sentinel"
    await expect(
      withIngestSpan("ingestion.step", {}, async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(
      JSON.stringify(
        exporter
          .getFinishedSpans()
          .map((s) => [s.attributes, s.status, s.events]),
      ),
    ).not.toContain("private sentinel")
  })
})
