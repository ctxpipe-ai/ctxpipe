import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { heldIngestSourceTrees } from "../../domain/ingestion/ingest-source-tree.js"
import { readIngestSkillBundle } from "../../domain/ingestion/skill-bundle.js"
import { generateObjectId } from "../../lib/id.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import { standInIngestShardRuntime } from "../../test/ingest-shard-stand-in.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { defineIngestionShardWorkflow } from "./ingestion-shard.js"
import { defineRepositoryIngestionV2Workflow } from "./repository-ingestion-v2.js"

/*
 * Ingestion v2 in shadow mode (T09), with real Postgres, a real OpenWorkflow
 * worker, the real ref broker, and real git. GitHub is a set of local bare
 * repositories (`url.<dir>.insteadOf https://github.com/`) and msw mints its
 * tokens. The sandbox is the host stand-in (`ingest-shard-stand-in.ts`):
 * the bundle's own scripts and stage helpers; msw answers its model calls.
 */

const MODEL_URL = "https://ingest-model.test/v1/step"
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}

const orgId = generateObjectId("org")
const connectionId = generateObjectId("con")
const suffix = Math.random().toString(36).slice(2, 8)
const sourceName = `acme/checkout-api-${suffix}`
const contexts = [`acme/context-a-${suffix}`, `acme/context-b-${suffix}`]
/** A source whose stand-in agent always says `more` and writes a rejected file. */
const stallName = `acme/stall-api-${suffix}`
/** A source with 21 roots: two shards. */
const wideName = `acme/wide-monorepo-${suffix}`
/**
 * The two-shard case: the sandbox of shard 0 does not start, and shard 1
 * waits at its second step until `release` is called.
 */
const wide = {
  waiting: false,
  release: () => {},
  gate: Promise.resolve(),
}
/**
 * The run takes its destinations in Workspace id order, and the tests expect
 * the first destination to be `workspaceIds[0]`. Two ids made one after the
 * other do not always sort in that order, so sort them.
 */
const workspaceIds = [generateObjectId("ws"), generateObjectId("ws")].sort()
const githubLog: GithubTokenLog = { minted: [], revoked: [] }
const modelCalls: Array<{
  step: string
  workspaceId: string
  root: string | null
  args: string[]
  index: string[]
}> = []

/**
 * The stand-in agent: one Service file for each root. The first page of the
 * `services/orders` step of the first Workspace says `more`, so the host runs
 * that skill again on the new tip (one paging channel, ADR-052 section 6).
 */
function modelReply(body: {
  step: string
  root: string | null
  workspaceId: string
  args?: string[]
}) {
  if (body.args?.includes(`https://github.com/${stallName}`))
    return {
      more: true,
      // The validator rejects a file outside the knowledge folders.
      files: [{ path: "notes/stall.md", content: "# Stall\n" }],
    }
  const root = body.root ?? "."
  const name = root === "." ? "checkout-api" : root.split("/").pop()
  const firstPage = !/\.\d+:/.test(body.step)
  return {
    more:
      root === "services/orders" &&
      body.workspaceId === workspaceIds[0] &&
      firstPage,
    files: [
      {
        path: `knowledge/services/${name}.md`,
        content: `---\nkind: Service\nname: ${name}\n---\n# ${name}\n\nThe ${name} service handles orders.\n`,
      },
    ],
  }
}

const server = setupServer(
  ...githubTokenHandlers(githubLog, () => "fixture-only-github-token"),
  http.post(MODEL_URL, async ({ request }) => {
    const body = (await request.json()) as {
      step: string
      root: string | null
      workspaceId: string
      args: string[]
      index: string[]
    }
    modelCalls.push(body)
    return HttpResponse.json(modelReply(body))
  }),
)

let folder: string
let remotes: string
let bundleDir: string
let backend: BackendPostgres
let worker: ReturnType<OpenWorkflow["newWorker"]>
let runner: OpenWorkflow
let parent: ReturnType<typeof defineRepositoryIngestionV2Workflow>
let sourceSha: string
let wideSha: string
let stallSha: string
const pinned: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trim()
}

/** A bare repository at `<remotes>/<name>` with one commit of `files`. */
function remote(name: string, files: Record<string, string>): string {
  const work = mkdtempSync(join(folder, "work-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "seed")
  const bare = join(remotes, name)
  mkdirSync(dirname(bare), { recursive: true })
  execFileSync("git", ["clone", "-q", "--bare", work, bare])
  return git(work, "rev-parse", "HEAD")
}

function refsOf(name: string): Record<string, string> {
  const out = git(
    join(remotes, name),
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/ctxpipe/",
  )
  return Object.fromEntries(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string]),
  )
}

const spanExporter = new InMemorySpanExporter()
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
})

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required for ingestion v2")
  tracerProvider.register()
  initDb(databaseUrl)
  stubGithubApp()
  server.listen({ onUnhandledRequest: "error" })
  folder = mkdtempSync(join(tmpdir(), "ingestion-v2-"))
  remotes = join(folder, "remotes")
  const gitConfig = join(folder, "gitconfig")
  writeFileSync(
    gitConfig,
    `[url "${remotes}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n`,
  )
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig)

  // The workspace manifest names both roots, so no model chooses a root.
  sourceSha = remote(sourceName, {
    "package.json": '{ "name": "checkout-api" }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "."\n  - services/*\n',
    "services/orders/package.json": '{ "name": "orders" }\n',
    "services/orders/src/index.ts": "export const orders = []\n",
    "README.md": "# Checkout API\n",
  })
  for (const name of contexts)
    pinned.push(remote(name, { "README.md": "# Context\n" }))
  stallSha = remote(stallName, {
    "package.json": '{ "name": "stall-api" }\n',
  })
  wideSha = remote(wideName, {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    ...Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => {
        const name = `p${String(i + 1).padStart(2, "0")}`
        return [`packages/${name}/package.json`, `{ "name": "${name}" }\n`]
      }),
    ),
  })

  // The bundle: the real stage helpers and script skills, and one fixture
  // model skill of the plan.
  const real = await readIngestSkillBundle()
  bundleDir = join(folder, "bundle")
  const kept = ["bin", "discover-roots", "repository", "libraries", "ownership"]
  for (const file of real.files.filter((f) =>
    kept.includes(f.path.split("/")[0] ?? ""),
  )) {
    mkdirSync(dirname(join(bundleDir, file.path)), { recursive: true })
    writeFileSync(join(bundleDir, file.path), file.content, {
      mode: file.executable ? 0o755 : 0o644,
    })
  }
  mkdirSync(join(bundleDir, "classify-kind"))
  writeFileSync(
    join(bundleDir, "classify-kind/SKILL.md"),
    "---\nname: classify-kind\ndescription: Fixture model skill.\n---\n# classify-kind\n",
  )

  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingestion v2 proof",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId: 444,
    accountSlug: "acme",
  })
  for (const [i, workspaceId] of workspaceIds.entries()) {
    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `context-${i}-${suffix}`,
        displayName: `Context ${i}`,
        workspaceRepositoryUrl: `https://github.com/${contexts[i]}`,
        githubConnectionId: connectionId,
        desiredGeneration: 3,
        desiredSha: pinned[i],
        desiredDefaultBranch: "main",
        writeStatus: "writable",
        // The publish gate: ingestion v2 publishes at format 3 or more.
        formatVersion: 3,
      }),
    )
    await replaceWorkspaceSourceRows({
      orgId,
      workspaceId,
      revision: pinned[i] ?? "",
      rows: [
        {
          sourceKey: "checkout",
          provider: "github",
          connectionId,
          scope: { repositories: [sourceName, wideName, stallName] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
  }

  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  runner = new OpenWorkflow({ backend })
  const standIn = standInIngestShardRuntime({ modelUrl: MODEL_URL, folder })
  const deps = {
    runtime: Object.assign(
      (spec: Parameters<typeof standIn>[0]) => {
        const inner = standIn(spec)
        if (spec.source.url !== `https://github.com/${wideName}`) return inner
        let steps = 0
        return {
          ...inner,
          async ensure() {
            if (spec.shard === 0)
              throw new Error("The sandbox of shard 0 does not start")
            return inner.ensure()
          },
          async runStep(step: Parameters<typeof inner.runStep>[0]) {
            if (spec.shard === 1 && ++steps === 2) {
              wide.waiting = true
              await wide.gate
            }
            return inner.runStep(step)
          },
        }
      },
      { destroy: standIn.destroy },
    ),
    bundle: () => readIngestSkillBundle(bundleDir),
  }
  const shard = defineIngestionShardWorkflow(deps)
  parent = defineRepositoryIngestionV2Workflow({ ...deps, shard })
  runner.implementWorkflow(shard.spec, shard.fn)
  runner.implementWorkflow(parent.spec, parent.fn)
  worker = runner.newWorker({ concurrency: 4 })
  await worker.start()
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await backend?.stop()
  await tracerProvider.shutdown()
  server.close()
  vi.unstubAllEnvs()
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
  rmSync(folder, { recursive: true, force: true })
}, 60_000)

describe("ingestion v2 in shadow mode", () => {
  it(
    "writes refs in both destination Workspaces, publishes nothing, and keeps each step output small",
    { timeout: 420_000 },
    async () => {
      const handle = await runner.runWorkflow(parent.spec, {
        orgId,
        shadow: true,
        source: {
          url: `https://github.com/${sourceName}`,
          githubConnectionId: connectionId,
        },
        sha: sourceSha,
        authorTime: "2026-10-01T00:00:00.000Z",
      })
      const result = await handle.result({ timeoutMs: 400_000 })
      const runId = handle.workflowRun.id

      // One model run per root and destination Workspace (2 roots, 2
      // Workspaces), and a second page for the step that said `more`.
      expect(modelCalls).toHaveLength(5)
      expect(new Set(modelCalls.map((c) => `${c.step}`)).size).toBe(5)
      expect(modelCalls.filter((c) => /\.2:/.test(c.step))).toEqual([
        expect.objectContaining({
          root: "services/orders",
          workspaceId: workspaceIds[0],
        }),
      ])
      expect(new Set(modelCalls.map((c) => c.workspaceId))).toEqual(
        new Set(workspaceIds),
      )
      const codebase = `knowledge/codebases/checkout-api-${suffix}.md`
      for (const call of modelCalls) {
        // One input shape: the root of a root step is `--path`.
        expect(call.args).toEqual(
          expect.arrayContaining(["--source-url", "--roots", "--path"]),
        )
        expect(call.args.at(-1)).toBe(call.root)
        // The index is at the step base: the repository unit of the first
        // step is in it.
        expect(call.index).toContain(codebase)
      }
      // The `services/orders` step runs after the `.` step of its shard, so
      // its index holds the file that the earlier step wrote.
      expect(
        modelCalls.find(
          (c) => c.root === "services/orders" && !/\.2:/.test(c.step),
        )?.index,
      ).toContain("knowledge/services/checkout-api.md")

      expect(result).toMatchObject({ status: "done", shards: 1 })
      if (result.status !== "done") throw new Error("The run did not finish")

      // Telemetry (T11): one run span with the source SHA and the bundle
      // hash, one span for the shard, and a span for each skill step.
      const spans = spanExporter.getFinishedSpans()
      const runSpans = spans.filter(
        (span) =>
          span.name === "ingestion.run" &&
          span.attributes["ctxpipe.ingest.run.id"] === runId,
      )
      expect(runSpans).toHaveLength(1)
      expect(runSpans[0]?.status.code).not.toBe(2)
      expect(runSpans[0]?.attributes).toMatchObject({
        "ctxpipe.ingest.source.sha": sourceSha,
        "ctxpipe.ingest.bundle": expect.stringMatching(/^ingest-[0-9a-f]{16}$/),
        "ctxpipe.ingest.mode": "shadow",
        "ctxpipe.ingest.status": "done",
        "ctxpipe.ingest.shards": 1,
        "ctxpipe.ingest.rejects": 0,
        "ctxpipe.ingest.partial": 0,
      })
      expect(
        spans.filter(
          (span) =>
            span.name === "ingestion.shard" &&
            span.attributes["ctxpipe.ingest.run.id"] === runId,
        ),
      ).not.toHaveLength(0)
      const stepSpans = spans.filter(
        (span) =>
          span.name === "ingestion.step" &&
          span.attributes["ctxpipe.ingest.run.id"] === runId,
      )
      expect(stepSpans.length).toBeGreaterThanOrEqual(5)
      for (const span of stepSpans)
        expect(span.attributes).toEqual(
          expect.objectContaining({
            "ctxpipe.ingest.ops": expect.any(Number),
            "ctxpipe.ingest.rejects": expect.any(Number),
            "ctxpipe.ingest.ref.tip": expect.stringMatching(/^[0-9a-f]{40}$/),
          }),
        )
      // The host validator accepted each file that the stand-in agent wrote.
      const steps = await getSystemDb().execute<{
        step_name: string
        output: unknown
      }>(sql`
        select step_name, output from openworkflow.step_attempts
        where namespace_id = ${openWorkflowNamespaceId()}
          and step_name like 'skill:%' and step_name not like 'skill:repository:%'
          and status = 'completed'
      `)
      expect(
        steps.rows
          .filter((row) => !/\.2:/.test(row.step_name))
          .map((row) => row.output),
      ).toEqual(Array(4).fill(expect.objectContaining({ ops: 1, rejects: 0 })))
      for (const [i, name] of contexts.entries()) {
        const workspaceId = workspaceIds[i] ?? ""
        const refs = refsOf(name)
        const prefix = `refs/ctxpipe/ingest/${runId}/${workspaceId}`
        expect(Object.keys(refs).sort()).toEqual([
          `${prefix}/assembled`,
          `${prefix}/shards/0`,
        ])
        const assembled = refs[`${prefix}/assembled`] ?? ""
        expect(result.workspaces).toContainEqual(
          expect.objectContaining({ workspaceId, assembled, partial: 0 }),
        )
        const files = git(
          join(remotes, name),
          "ls-tree",
          "-r",
          "--name-only",
          assembled,
        ).split("\n")
        expect(files).toEqual(
          expect.arrayContaining([
            "knowledge/services/checkout-api.md",
            "knowledge/services/orders.md",
          ]),
        )
        const orders = git(
          join(remotes, name),
          "show",
          `${assembled}:knowledge/services/orders.md`,
        )
        expect(orders).toContain("generated_by: ctxpipe-extract")
        // The host root of each root step's package unit (CTX-657).
        expect(orders).toContain("root: services/orders")
        expect(
          git(
            join(remotes, name),
            "show",
            `${assembled}:knowledge/services/checkout-api.md`,
          ),
        ).toContain("root: .")
        // The repository unit of the first step, with the host fields.
        const unit = git(
          join(remotes, name),
          "show",
          `${assembled}:${codebase}`,
        )
        expect(unit).toContain("kind: Repository")
        expect(unit).toContain("root: .")
        expect(unit).toContain(`- https://github.com/${sourceName}`)
        // Shadow mode publishes nothing: the default branch did not move.
        expect(git(join(remotes, name), "rev-parse", "main")).toBe(pinned[i])
      }

      // The parent and each child deleted their copies of the source tree.
      expect(heldIngestSourceTrees(runId)).toBe(0)

      // Each step output holds a SHA and counts, far below 16 KB.
      const sizes = await getSystemDb().execute<{ largest: number }>(sql`
        select coalesce(max(octet_length(output::text)), 0)::int as largest
        from openworkflow.step_attempts
        where namespace_id = ${openWorkflowNamespaceId()}
      `)
      expect(sizes.rows[0]?.largest).toBeGreaterThan(0)
      expect(sizes.rows[0]?.largest).toBeLessThan(16 * 1024)
    },
  )
})

describe("ingestion v2 paging", () => {
  it(
    "stops a skill whose page says more but has no accepted op, and marks it partial",
    { timeout: 420_000 },
    async () => {
      const before = modelCalls.length
      const handle = await runner.runWorkflow(parent.spec, {
        orgId,
        shadow: true,
        source: {
          url: `https://github.com/${stallName}`,
          githubConnectionId: connectionId,
        },
        sha: stallSha,
        authorTime: "2026-10-04T00:00:00.000Z",
      })
      const result = await handle.result({ timeoutMs: 400_000 })
      // One page for each Workspace, not 20: no page after a page that
      // accepted nothing.
      const calls = modelCalls.slice(before)
      expect(calls).toHaveLength(2)
      expect(calls.every((c) => !/\.\d+:/.test(c.step))).toBe(true)
      expect(result).toMatchObject({ status: "partial" })
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      for (const workspace of result.workspaces)
        expect(workspace).toMatchObject({ partial: 1, rejects: 1 })
    },
  )
})

describe("ingestion v2 with a failed shard", () => {
  it(
    "waits for a sibling shard that still runs before the run fails, and keeps the run unfailed until then",
    { timeout: 420_000 },
    async () => {
      wide.gate = new Promise<void>((resolve) => {
        wide.release = resolve
      })
      const handle = await runner.runWorkflow(parent.spec, {
        orgId,
        shadow: true,
        source: {
          url: `https://github.com/${wideName}`,
          githubConnectionId: connectionId,
        },
        sha: wideSha,
        authorTime: "2026-10-03T00:00:00.000Z",
      })
      const runId = handle.workflowRun.id
      try {
        // The parent saw the failed shard 0: its child step failed, and the
        // parent is parked. OpenWorkflow 0.10 parks a run as `running` with
        // no worker (the `sleeping` status is deprecated).
        const deadline = Date.now() + 300_000
        let parentStatus = ""
        for (;;) {
          const rows = await getSystemDb().execute<{
            step: string | null
            run: string
            parked: boolean
          }>(sql`
            select
              (select sa.status from openworkflow.step_attempts sa
                where sa.namespace_id = wr.namespace_id
                  and sa.workflow_run_id = wr.id and sa.step_name = 'shard:0'
                order by sa.created_at desc limit 1) as step,
              wr.status as run,
              wr.worker_id is null as parked
            from openworkflow.workflow_runs wr
            where wr.namespace_id = ${openWorkflowNamespaceId()}
              and wr.id = ${runId}
          `)
          const row = rows.rows[0]
          // The parent can park before the sibling reaches its gate.
          if (
            row?.step === "failed" &&
            (row.run !== "running" || (row.parked && wide.waiting))
          ) {
            parentStatus = row.run
            break
          }
          if (Date.now() > deadline)
            throw new Error(`Shard 0 did not fail: ${JSON.stringify(row)}`)
          await delay(200)
        }
        expect(wide.waiting).toBe(true)
        // Shard 1 still runs, so the parent waits: the run is not failed,
        // and the tip check keeps the refs that shard 1 writes.
        expect(parentStatus).toBe("running")
        expect(Object.keys(refsOf(contexts[0] ?? ""))).toContain(
          `refs/ctxpipe/ingest/${runId}/${workspaceIds[0]}/shards/1`,
        )
      } finally {
        wide.release()
      }
      await expect(handle.result({ timeoutMs: 300_000 })).rejects.toThrow(
        /The sandbox of shard 0 does not start/,
      )
      expect(heldIngestSourceTrees(runId)).toBe(0)
    },
  )
})

describe("ingestion v2 after a killed worker", () => {
  it(
    "resumes a step that crashed after its push, with no second model call for that step",
    { timeout: 600_000 },
    async () => {
      // Only the child workers below may claim this run.
      await worker.stop()
      const calls: string[] = []
      const local = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
        response.setHeader("content-type", "application/json")
        if (request.url?.endsWith("/access_tokens")) {
          response.statusCode = 201
          response.end(
            JSON.stringify({
              token: "fixture-only-github-token",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions: { contents: "write", metadata: "read" },
            }),
          )
        } else if (request.url === "/v1/step") {
          calls.push(body.step)
          response.end(JSON.stringify(modelReply(body)))
        } else {
          response.statusCode = 404
          response.end("{}")
        }
      })
      await new Promise<void>((resolve) =>
        local.listen(0, "127.0.0.1", resolve),
      )
      const address = local.address()
      if (!address || typeof address === "string")
        throw new Error("The local GitHub and model stand-in has no port")
      const proxy = `http://127.0.0.1:${address.port}`
      const require = createRequire(import.meta.url)
      const module = (path: string) =>
        JSON.stringify(new URL(path, import.meta.url).href)
      const script = join(folder, "ingestion-v2-worker.ts")
      writeFileSync(
        script,
        `
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  return nativeFetch(["api.github.com", "ingest-model.test"].includes(url.hostname)
    ? new Request(${JSON.stringify(proxy)} + url.pathname + url.search, request) : request);
};
const { OpenWorkflow } = await import(${JSON.stringify(pathToFileURL(require.resolve("openworkflow")).href)});
const { BackendPostgres } = await import(${JSON.stringify(pathToFileURL(require.resolve("openworkflow/postgres")).href)});
const { initDb } = await import(${module("../../db/client.ts")});
const { readIngestSkillBundle } = await import(${module("../../domain/ingestion/skill-bundle.ts")});
const { standInIngestShardRuntime } = await import(${module("../../test/ingest-shard-stand-in.ts")});
const { defineIngestionShardWorkflow } = await import(${module("./ingestion-shard.ts")});
const { defineRepositoryIngestionV2Workflow } = await import(${module("./repository-ingestion-v2.ts")});
initDb(process.env.DATABASE_URL);
const backend = await BackendPostgres.connect(process.env.DATABASE_URL, { namespaceId: ${JSON.stringify(openWorkflowNamespaceId())}, runMigrations: false });
const runner = new OpenWorkflow({ backend });
const deps = {
  runtime: standInIngestShardRuntime({ modelUrl: ${JSON.stringify(MODEL_URL)}, folder: ${JSON.stringify(folder)} }),
  bundle: () => readIngestSkillBundle(${JSON.stringify(bundleDir)}),
};
const shard = defineIngestionShardWorkflow(deps);
const parent = defineRepositoryIngestionV2Workflow({ ...deps, shard });
runner.implementWorkflow(shard.spec, shard.fn);
runner.implementWorkflow(parent.spec, parent.fn);
await runner.newWorker({ concurrency: 4 }).start();
await new Promise(() => {});
`,
      )
      // A git that stops after the first push to a shard ref has landed,
      // before the step can record its output.
      const pushed = join(folder, "step-pushed")
      const bin = join(folder, "crash-bin")
      mkdirSync(bin)
      const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim()
      writeFileSync(
        join(bin, "git"),
        `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (result.status === 0 && args.includes("push") && args.some((a) => a.includes("/shards/0")) && !existsSync(${JSON.stringify(pushed)})) {
  writeFileSync(${JSON.stringify(pushed)}, args.join(" "));
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      )
      const children: ChildProcess[] = []
      let childErrors = ""
      const launch = (crash: boolean) => {
        const child = spawn("bun", [script], {
          cwd: folder,
          detached: true,
          env: {
            ...process.env,
            ...(crash ? { PATH: `${bin}:${process.env.PATH}` } : {}),
          },
          stdio: ["ignore", "ignore", "pipe"],
        })
        child.stderr?.on("data", (data) => {
          childErrors = (childErrors + data.toString()).slice(-8_000)
        })
        children.push(child)
        return child
      }
      try {
        const handle = await runner.runWorkflow(parent.spec, {
          orgId,
          shadow: true,
          source: {
            url: `https://github.com/${sourceName}`,
            githubConnectionId: connectionId,
          },
          sha: sourceSha,
          authorTime: "2026-10-02T00:00:00.000Z",
        })
        const crashing = launch(true)
        const deadline = Date.now() + 90_000
        while (!existsSync(pushed)) {
          if (Date.now() > deadline)
            throw new Error(`No step push happened: ${childErrors}`)
          await delay(200)
        }
        if (crashing.pid) process.kill(-crashing.pid, "SIGKILL")
        const crashedStep = calls[0]
        expect(calls).toHaveLength(1)
        // The step's commit is on the shard ref, but the step has no output.
        const runId = handle.workflowRun.id
        const ref = `refs/ctxpipe/ingest/${runId}/${workspaceIds[0]}/shards/0`
        expect(Object.keys(refsOf(contexts[0] ?? ""))).toContain(ref)

        launch(false)
        const result = await handle.result({ timeoutMs: 400_000 })
        expect(result).toMatchObject({ status: "done", shards: 1 })
        // One model call per step: the crashed step found its commit.
        expect(calls).toHaveLength(5)
        expect(new Set(calls).size).toBe(5)
        expect(calls.filter((step) => step === crashedStep)).toHaveLength(1)
        for (const [i, name] of contexts.entries()) {
          const prefix = `refs/ctxpipe/ingest/${runId}/${workspaceIds[i]}`
          expect(Object.keys(refsOf(name))).toEqual(
            expect.arrayContaining([
              `${prefix}/assembled`,
              `${prefix}/shards/0`,
            ]),
          )
        }
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nChild worker stderr: ${childErrors}`,
        )
      } finally {
        for (const child of children)
          if (child.pid && child.exitCode === null && child.signalCode === null)
            try {
              process.kill(-child.pid, "SIGKILL")
            } catch {}
        local.close()
      }
    },
  )
})
