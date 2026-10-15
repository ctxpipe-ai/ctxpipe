import { trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import { IngestRefRefusedError } from "../../domain/ingestion/ingest-refs.js"
import type {
  IngestDestination,
  IngestShardRuntime,
} from "../../domain/ingestion/ingest-shard-runtime.js"
import { skillStepName } from "../../domain/ingestion/ingestion-plan.js"
import type { PatchStepResult } from "../../domain/ingestion/patch-validator.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  type IngestionShardWorkspace,
  runSkillPages,
  type SkillStepBroker,
} from "./ingestion-shard.js"

/*
 * Telemetry of one skill step (ADR-052, T11): the step span holds the ref
 * SHAs and the op and reject counts; each rejected op and each `partial`
 * reason is its own log event; no span or log holds source content.
 */

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
const events: Array<Record<string, unknown>> = []

beforeAll(() => {
  // The workflow modules connect to Postgres when they load.
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the ingestion workflow")
  provider.register()
})

beforeEach(() => {
  exporter.reset()
  events.length = 0
  initLogger({
    pretty: false,
    silent: true,
    env: { service: "ctxpipe-backend-test" },
    drain: (ctx) => {
      events.push(ctx.event as Record<string, unknown>)
    },
  })
})

afterEach(() => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
})

afterAll(async () => {
  await provider.shutdown()
})

const skillStep = skillStepName("services/api", "apis", "ws_test")
const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const destination: IngestDestination = {
  workspaceId: "ws_test",
  url: "https://github.com/example-org/context",
  githubConnectionId: "con_test",
  generation: 1,
  pinnedRevision: SHA_A,
  repositoryId: null,
}

/** The sandbox returns an empty tar: the fake broker does not read it. */
const runtime = {
  ensure: async () => {},
  discoverRoots: async () => ({}),
  runStep: async () => ({ tar: new Uint8Array(1024) }),
} satisfies IngestShardRuntime

function broker(overrides: Partial<SkillStepBroker> = {}): SkillStepBroker {
  return {
    find: async () => null,
    listFiles: async () => [],
    push: async () => {
      throw new Error("push is not set")
    },
    sourcePathExists: async () => true,
    readSourceFile: async () => null,
    ...overrides,
  }
}

function validation(over: Partial<PatchStepResult>): PatchStepResult {
  return {
    tree: "t".repeat(40),
    accepted: [],
    rejections: [],
    status: "complete",
    more: false,
    ...over,
  }
}

async function runStep(skillBroker: SkillStepBroker) {
  const state: IngestionShardWorkspace = {
    workspaceId: destination.workspaceId,
    tip: null,
    ops: 0,
    rejects: 0,
    partial: 0,
  }
  await withLogger(createLogger({ workflow: "test" }), () =>
    runSkillPages({
      step: (_name, fn) => fn(),
      run: {
        runId: "run_test",
        shard: 2,
        bundle: "ingest-0123456789abcdef",
        source: {
          url: "https://github.com/example-org/shop",
          githubConnectionId: "con_source",
          sha: SHA_A,
          repositoryId: null,
        },
        authorTime: "2026-10-01T00:00:00.000Z",
        roots: [],
      },
      broker: skillBroker,
      runtime,
      root: "services/api",
      skill: { name: "apis", scope: "root", run: "model", tier: "medium" },
      destination,
      ref: "refs/ctxpipe/ingest/run_test/ws_test/shards/2",
      runBase: SHA_A,
      state,
    }),
  )
  return state
}

function stepSpan() {
  return exporter
    .getFinishedSpans()
    .find((span) => span.name === "ingestion.step")
}

describe("ingestion step telemetry", () => {
  it("puts the ref SHAs and the op and reject counts on the step span, with the run, shard, step, and skill", async () => {
    const state = await runStep(
      broker({
        push: async () => ({
          sha: SHA_B,
          more: false,
          validation: validation({
            accepted: [
              { op: "create", path: "knowledge/apis/orders.md" },
              { op: "update", path: "knowledge/services/api.md" },
            ],
            rejections: [
              {
                path: "knowledge/apis/bad.md",
                rule: "front_matter",
                reason: "x",
              },
            ],
          }),
        }),
      }),
    )
    expect(state).toMatchObject({ tip: SHA_B, ops: 2, rejects: 1, partial: 0 })
    const span = stepSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.ingest.run.id": "run_test",
      "ctxpipe.ingest.shard": "2",
      "ctxpipe.ingest.step": skillStep,
      "ctxpipe.ingest.skill": "apis",
      "ctxpipe.workspace.id": "ws_test",
      "ctxpipe.ingest.ref.base": SHA_A,
      "ctxpipe.ingest.ref.tip": SHA_B,
      "ctxpipe.ingest.ops": 2,
      "ctxpipe.ingest.rejects": 1,
      "ctxpipe.ingest.more": false,
      "ctxpipe.ingest.validation": "complete",
      "ctxpipe.ingest.attempts": 1,
    })
    // No file path of the context repository.
    expect(JSON.stringify(span?.attributes)).not.toContain("knowledge/")
  })

  it("logs each rejected op as its own event, so two rejects do not overwrite each other", async () => {
    await runStep(
      broker({
        push: async () => ({
          sha: SHA_B,
          more: false,
          validation: validation({
            accepted: [{ op: "create", path: "knowledge/apis/ok.md" }],
            rejections: [
              {
                path: "knowledge/apis/one.md",
                rule: "front_matter",
                reason: "first reason",
              },
              {
                path: "knowledge/apis/two.md",
                rule: "link",
                reason: "second reason",
              },
            ],
          }),
        }),
      }),
    )
    const rejected = events.filter(
      (event) => event.step === "ingestion-v2.op-rejected",
    )
    expect(rejected).toHaveLength(2)
    expect(rejected.map((event) => event.path)).toEqual([
      "knowledge/apis/one.md",
      "knowledge/apis/two.md",
    ])
    expect(rejected[0]).toMatchObject({
      level: "warn",
      ingestionRunId: "run_test",
      shard: 2,
      workspaceId: "ws_test",
      rule: "front_matter",
      reason: "first reason",
    })
    expect(rejected[1]).toMatchObject({ rule: "link", reason: "second reason" })
  })

  it("logs the reason when the validator rejects more than half of the ops", async () => {
    await runStep(
      broker({
        push: async () => ({
          sha: SHA_B,
          more: false,
          validation: validation({
            status: "partial",
            accepted: [{ op: "create", path: "knowledge/apis/ok.md" }],
            rejections: [
              { path: "knowledge/apis/a.md", rule: "path", reason: "r" },
              { path: "knowledge/apis/b.md", rule: "path", reason: "r" },
            ],
          }),
        }),
      }),
    )
    expect(stepSpan()?.attributes["ctxpipe.ingest.validation"]).toBe("partial")
    const mostly = events.find(
      (event) => event.step === "ingestion-v2.step-mostly-rejected",
    )
    expect(mostly?.reason).toBe("The validator rejected 2 ops and accepted 1")
  })

  it("logs a refused step as partial with a capped reason, and marks the span", async () => {
    const stderr = `Error: ${"secret source line ".repeat(500)}`
    const state = await runStep(
      broker({
        push: async () => {
          throw new IngestRefRefusedError(stderr)
        },
      }),
    )
    expect(state.partial).toBe(1)
    const partial = events.find(
      (event) => event.step === "ingestion-v2.step-partial",
    )
    expect(partial).toMatchObject({
      level: "warn",
      ingestionRunId: "run_test",
      workspaceId: "ws_test",
      ingestStep: skillStep,
    })
    expect(String(partial?.reason).length).toBeLessThanOrEqual(503)
    const span = stepSpan()
    expect(span?.attributes["ctxpipe.ingest.partial"]).toBe(true)
    expect(span?.status.code).toBe(2)
    // The span keeps no error text, which can hold script output.
    expect(
      JSON.stringify({
        attributes: span?.attributes,
        status: span?.status,
        events: span?.events,
      }),
    ).not.toContain("secret source line")
  })

  it("makes the step span a child of the active span", async () => {
    await trace
      .getTracer("test")
      .startActiveSpan("ingestion.shard", async (parent) => {
        await runStep(
          broker({
            push: async () => ({
              sha: SHA_B,
              more: false,
              validation: validation({}),
            }),
          }),
        )
        parent.end()
        expect(stepSpan()?.parentSpanContext?.spanId).toBe(
          parent.spanContext().spanId,
        )
      })
  })
})
