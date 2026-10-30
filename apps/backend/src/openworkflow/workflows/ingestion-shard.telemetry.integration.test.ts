import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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

import { closeDb, initDb } from "../../db/client.js"
import {
  findStepCommit,
  ingestRefName,
  listStepFiles,
  pushIngestStep,
} from "../../domain/ingestion/ingest-refs.js"
import { IngestStepCommandError } from "../../domain/ingestion/ingest-shard-ops.js"
import type { IngestShardRuntime } from "../../domain/ingestion/ingest-shard-runtime.js"
import { skillStepName } from "../../domain/ingestion/ingestion-plan.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  openWorkflowExecution,
  type WorkflowExecution,
} from "../execution-lease.js"
import {
  type IngestionShardWorkspace,
  runSkillPages,
  type SkillStepBroker,
} from "./ingestion-shard.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
const events: Array<Record<string, unknown>> = []
let folder: string
let pinned: string
let remote: { url: string }
const runId = "run_test"
const workspaceId = "ws_test"
const ref = ingestRefName({ runId, workspaceId, shard: "2" })

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim()
}
function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
/** A staged step output (`files/<path>` and `patch.json`). */
function staged(files: Record<string, string>, stats?: object) {
  const out = mkdtempSync(join(folder, "out-"))
  mkdirSync(join(out, "files"))
  for (const [path, text] of Object.entries(files))
    write(join(out, "files"), path, text)
  write(
    out,
    "patch.json",
    JSON.stringify({
      ops: Object.keys(files).map((path) => ({ op: "create", path })),
      ...(stats ? { stats } : {}),
    }),
  )
  return out
}
function archive(files: Record<string, string>, stats?: object) {
  const out = staged(files, stats)
  return execFileSync("tar", ["-cf", "-", "-C", out, "patch.json", "files"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
}
const service =
  "---\nkind: Service\nname: Orders\n---\n# Orders\n\nThe orders service.\n"

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
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
  folder = mkdtempSync(join(tmpdir(), "ingest-telemetry-"))
  const work = join(folder, "work")
  mkdirSync(work)
  git(work, "init", "-q", "-b", "main")
  write(work, "README.md", "# Context\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "seed")
  pinned = git(work, "rev-parse", "HEAD")
  remote = { url: join(folder, "remote.git") }
  git(folder, "clone", "-q", "--bare", work, remote.url)
})
afterEach(() => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  rmSync(folder, { recursive: true, force: true })
})
afterAll(async () => {
  await provider.shutdown()
})

async function runStep(
  files: Record<string, string>,
  options: {
    runtime?: IngestShardRuntime
    ref?: string
    execution?: WorkflowExecution
  } = {},
) {
  const broker: SkillStepBroker = {
    find: (ref, step, since) =>
      findStepCommit({ remote, ref, step, runId, since }),
    listFiles: (pinnedRevision, tip) =>
      listStepFiles({ remote, runId, pinnedRevision, tip }),
    push: (input) =>
      pushIngestStep({ ...input, remote, job: { runId, workspaceId } }),
    sourcePathExists: async () => false,
    readSourceFile: async () => null,
  }
  const runtime: IngestShardRuntime = options.runtime ?? {
    ensure: async () => {},
    discoverRoots: async () => ({}),
    runStep: async () => ({ tar: archive(files) }),
  }
  const state: IngestionShardWorkspace = {
    workspaceId,
    tip: null,
    ops: 0,
    rejects: 0,
    partial: 0,
    partialRoots: [],
  }
  await withLogger(createLogger({ workflow: "test" }), () =>
    runSkillPages({
      step: (_name, fn) => fn(),
      ...(options.execution ? { execution: options.execution } : {}),
      run: {
        runId,
        shard: 2,
        bundle: "bundle-1",
        source: {
          kind: "github" as const,
          url: "https://github.com/example-org/shop",
          githubConnectionId: "con_source",
          sha: "a".repeat(40),
          repositoryId: null,
        },
        authorTime: "2026-10-01T00:00:00Z",
        roots: [],
      },
      broker,
      runtime,
      root: "services/api",
      skill: { name: "apis", scope: "root", run: "model", tier: "medium" },
      destination: {
        workspaceId,
        url: "https://github.com/example-org/context",
        githubConnectionId: "con_test",
        generation: 1,
        pinnedRevision: pinned,
        repositoryId: null,
        sourcePath: "sources/github/example-org/shop.md",
      },
      ref: options.ref ?? ref,
      runBase: pinned,
      state,
    }),
  )
  return state
}
function spans() {
  return exporter.getFinishedSpans().map((s) => ({
    name: s.name,
    attributes: s.attributes,
    status: s.status,
    events: s.events,
  }))
}
function stepSpan() {
  return exporter.getFinishedSpans().find((s) => s.name === "ingestion.step")
}

describe("ingestion step telemetry with the local git broker", () => {
  it("records real validation counts and preserves them after a push and resume", async () => {
    const files = {
      "knowledge/services/orders.md": service,
      "AGENTS.md": "private sentinel",
    }
    const first = await runStep(files)
    expect(first).toMatchObject({ ops: 1, rejects: 1, partial: 0 })
    expect(stepSpan()?.attributes).toMatchObject({
      "ctxpipe.ingest.ref.base": pinned,
      "ctxpipe.ingest.ref.tip": first.tip,
      "ctxpipe.ingest.ops": 1,
      "ctxpipe.ingest.rejects": 1,
    })
    exporter.reset()
    expect(await runStep(files)).toEqual(first)
    expect(stepSpan()?.attributes["ctxpipe.ingest.rejects"]).toBe(1)
  })
  it("puts the counts of the step output on the step span, and drops a count with a bad name or value", async () => {
    await runStep(
      {},
      {
        runtime: {
          ensure: async () => {},
          discoverRoots: async () => ({}),
          runStep: async () => ({
            tar: archive(
              {},
              {
                "candidates.http": 2,
                "skipped.no_service": 1,
                "private sentinel": 3,
                "resolutions.ignore": "private sentinel",
                "ops.negative": -1,
              },
            ),
          }),
        },
      },
    )
    const attributes = stepSpan()?.attributes ?? {}
    expect(attributes["ctxpipe.ingest.stat.candidates.http"]).toBe(2)
    expect(attributes["ctxpipe.ingest.stat.skipped.no_service"]).toBe(1)
    expect(
      Object.keys(attributes).filter((k) =>
        k.startsWith("ctxpipe.ingest.stat."),
      ),
    ).toHaveLength(2)
    expect(JSON.stringify(spans())).not.toContain("private sentinel")
  })
  it("exports each rejection and the partial validation result", async () => {
    await runStep({
      "knowledge/services/orders.md": service,
      "AGENTS.md": "private sentinel",
      "CLAUDE.md": "private sentinel",
    })
    expect(
      events.filter((e) => e.step === "ingestion-v2.op-rejected"),
    ).toHaveLength(2)
    expect(stepSpan()?.attributes["ctxpipe.ingest.validation"]).toBe("partial")
    expect(
      events.find((e) => e.step === "ingestion-v2.step-mostly-rejected")
        ?.reason,
    ).toBe("The validator rejected 2 ops and accepted 1")
    expect(JSON.stringify([events, spans()])).not.toContain("private sentinel")
  })
  it("keeps broker error text out of logs and spans", async () => {
    expect((await runStep({}, { ref: "refs/private-sentinel" })).partial).toBe(
      1,
    )
    expect(
      events.find((e) => e.step === "ingestion-v2.step-partial")?.reason,
    ).toBe("broker_refused")
    expect(JSON.stringify([events, spans()])).not.toContain("private-sentinel")
  })
  it(
    "keeps runtime error text and names out of logs and spans",
    { timeout: 25000 },
    async () => {
      const error = new Error("private sentinel")
      error.name = "private sentinel"
      const runtime = {
        ensure: async () => {},
        discoverRoots: async () => ({}),
        runStep: async () => {
          throw error
        },
      }
      expect((await runStep({}, { runtime })).partial).toBe(1)
      expect(
        events.find((e) => e.step === "ingestion-v2.step-partial")?.reason,
      ).toBe("step_failed")
      // A step that stays `partial` keeps the error type of its last attempt.
      expect(stepSpan()?.attributes["error.type"]).toBe("Error")
      // Each failed attempt logs where it failed and the error class, with
      // no error text.
      expect(
        events
          .filter((e) => e.step === "ingestion-v2.step-attempt-failed")
          .map((e) => [e.attempt, e.stage, e.exitCode, e.errorClass]),
      ).toEqual([
        [1, "runtime", undefined, "Error"],
        [2, "runtime", undefined, "Error"],
        [3, "runtime", undefined, "Error"],
      ])
      expect(JSON.stringify([events, spans()])).not.toContain(
        "private sentinel",
      )
    },
  )
  it(
    "logs the code and the known start of a runtime error, with no source text",
    { timeout: 25000 },
    async () => {
      const runtime = {
        ensure: async () => {},
        discoverRoots: async () => ({}),
        runStep: async () => {
          throw Object.assign(
            new Error("Ingest root command failed (exit -1): private sentinel"),
            { code: "ECONNRESET" },
          )
        },
      }
      expect((await runStep({}, { runtime })).partial).toBe(1)
      expect(
        events
          .filter((e) => e.step === "ingestion-v2.step-attempt-failed")
          .map((e) => [e.stage, e.errorCode, e.errorKind]),
      ).toEqual(
        Array(3).fill([
          "runtime",
          "ECONNRESET",
          "Ingest root command failed (exit -1)",
        ]),
      )
      expect(JSON.stringify([events, spans()])).not.toContain(
        "private sentinel",
      )
    },
  )
  it(
    "logs the step command and its exit code of a failed attempt, with no stderr",
    { timeout: 25000 },
    async () => {
      const runtime = {
        ensure: async () => {},
        discoverRoots: async () => ({}),
        runStep: async () => {
          throw new IngestStepCommandError("finish", 3, "private sentinel")
        },
      }
      expect((await runStep({}, { runtime })).partial).toBe(1)
      expect(
        events
          .filter((e) => e.step === "ingestion-v2.step-attempt-failed")
          .map((e) => [e.stage, e.exitCode]),
      ).toEqual([
        ["finish", 3],
        ["finish", 3],
        ["finish", 3],
      ])
      expect(JSON.stringify([events, spans()])).not.toContain(
        "private sentinel",
      )
    },
  )
  it(
    "logs the model calls and the error names and HTTP statuses of a failed model command, with no message",
    { timeout: 25000 },
    async () => {
      const runtime = {
        ensure: async () => {},
        discoverRoots: async () => ({}),
        runStep: async () => {
          throw new IngestStepCommandError("skill", 1, "private sentinel", {
            calls: 0,
            errors: [{ name: "APIError", status: 502 }],
          })
        },
      }
      expect((await runStep({}, { runtime })).partial).toBe(1)
      expect(
        events
          .filter((e) => e.step === "ingestion-v2.step-attempt-failed")
          .map((e) => [e.stage, e.exitCode, e.modelCalls, e.modelErrors]),
      ).toEqual(
        Array(3).fill(["skill", 1, 0, [{ name: "APIError", status: 502 }]]),
      )
      expect(JSON.stringify([events, spans()])).not.toContain(
        "private sentinel",
      )
    },
  )
  it(
    "keeps tar error text out of logs and spans",
    { timeout: 25000 },
    async () => {
      const path = join(folder, "private sentinel")
      writeFileSync(path, "fixture")
      const tar = execFileSync("tar", ["-P", "-cf", "-", path], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      })
      const runtime = {
        ensure: async () => {},
        discoverRoots: async () => ({}),
        runStep: async () => ({ tar }),
      }
      expect((await runStep({}, { runtime })).partial).toBe(1)
      expect(JSON.stringify([events, spans()])).not.toContain(
        "private sentinel",
      )
    },
  )
  /** Another execution of the child pushes `step` on the ref from `oldTip`. */
  async function otherExecutionPushes(
    step: string,
    oldTip: string | null,
    files: Record<string, string>,
  ) {
    return pushIngestStep({
      job: { runId, workspaceId },
      ref,
      oldTip,
      pinnedRevision: pinned,
      baseCommit: oldTip ?? pinned,
      remote,
      commit: {
        step,
        bundle: "bundle-1",
        authorTime: new Date("2026-10-01T00:00:00Z"),
      },
      patch: {
        stagedDir: staged(files),
        source: {
          url: "https://github.com/example-org/shop",
          sha: "a".repeat(40),
        },
        sourcePath: "sources/github/example-org/shop.md",
        skill: "apis",
        sourcePathExists: async () => false,
        readSourceFile: async () => null,
      },
    })
  }
  it(
    "records the adopted commit of another execution, with no error type after the adoption",
    { timeout: 25000 },
    async () => {
      let other = ""
      const runtime = {
        ensure: async () => {},
        discoverRoots: async () => ({}),
        runStep: async () => {
          // The other execution pushes this step while this one runs it:
          // the push of this attempt fails, and the next attempt adopts.
          if (!other)
            other = (
              await otherExecutionPushes(
                skillStepName("services/api", "apis", workspaceId),
                null,
                { "knowledge/services/orders.md": service },
              )
            ).sha
          return { tar: archive({ "knowledge/services/orders.md": service }) }
        },
      }
      const state = await runStep({}, { runtime })
      expect(state).toMatchObject({ tip: other, ops: 1, partial: 0 })
      const attributes = stepSpan()?.attributes ?? {}
      expect(attributes).toMatchObject({
        "ctxpipe.ingest.attempts": 2,
        "ctxpipe.ingest.adopted": "commit",
        "ctxpipe.ingest.adopted.ops": 1,
      })
      expect(attributes["error.type"]).toBeUndefined()
    },
  )
  it("records the adopted tip of another execution and its ops", async () => {
    await otherExecutionPushes(
      skillStepName("services/api", "classify-kind", workspaceId),
      null,
      { "knowledge/services/orders.md": service },
    )
    const state = await runStep({
      "knowledge/services/payments.md": service.replaceAll(
        "Orders",
        "Payments",
      ),
    })
    expect(state).toMatchObject({ ops: 2, partial: 0 })
    expect(stepSpan()?.attributes).toMatchObject({
      "ctxpipe.ingest.attempts": 1,
      "ctxpipe.ingest.adopted": "tip",
      "ctxpipe.ingest.adopted.ops": 1,
      "ctxpipe.ingest.ref.base": pinned,
    })
  })
  it("goes on with the step when the worker cannot read the lease of the run", async () => {
    // A database that refuses the connection: the read of the run fails.
    // That is not a lease loss, so the live execution must not stop.
    initDb("postgresql://ctxpipe:ctxpipe@127.0.0.1:1/unreachable")
    try {
      const state = await runStep(
        { "knowledge/services/orders.md": service },
        { execution: openWorkflowExecution({ workerId: "worker-1" }, "wr_1") },
      )
      expect(state).toMatchObject({ ops: 1, partial: 0 })
      expect(
        events.filter(
          (e) => e.step === "ingestion-v2.execution-lease-check-failed",
        ),
      ).toEqual([
        expect.objectContaining({
          level: "warn",
          ingestStep: skillStepName("services/api", "apis", workspaceId, 1),
          attempt: 1,
          workflowRunId: "wr_1",
        }),
      ])
      expect(
        events.filter((e) => e.step === "ingestion-v2.execution-lease-lost"),
      ).toEqual([])
    } finally {
      await closeDb()
    }
  })
  it("makes the step span a child of the active shard span", async () => {
    await trace
      .getTracer("test")
      .startActiveSpan("ingestion.shard", async (parent) => {
        await runStep({})
        parent.end()
        expect(stepSpan()?.parentSpanContext?.spanId).toBe(
          parent.spanContext().spanId,
        )
      })
  })
})
