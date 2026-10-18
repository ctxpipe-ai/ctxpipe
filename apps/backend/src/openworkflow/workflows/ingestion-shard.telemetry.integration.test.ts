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
import {
  findStepCommit,
  ingestRefName,
  listStepFiles,
  pushIngestStep,
} from "../../domain/ingestion/ingest-refs.js"
import type { IngestShardRuntime } from "../../domain/ingestion/ingest-shard-runtime.js"
import { createLogger, withLogger } from "../../observability/logger.js"
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
function archive(files: Record<string, string>) {
  const out = mkdtempSync(join(folder, "out-"))
  mkdirSync(join(out, "files"))
  for (const [path, text] of Object.entries(files))
    write(join(out, "files"), path, text)
  write(
    out,
    "patch.json",
    JSON.stringify({
      ops: Object.keys(files).map((path) => ({ op: "create", path })),
    }),
  )
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
  options: { runtime?: IngestShardRuntime; ref?: string } = {},
) {
  const broker: SkillStepBroker = {
    find: (ref, step) => findStepCommit({ remote, ref, step, runId }),
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
