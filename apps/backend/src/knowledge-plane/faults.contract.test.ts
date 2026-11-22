import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { ClickHouseClient } from "@clickhouse/client"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  createKnowledgeStore,
  type KnowledgeStore,
  ORG_SETTING,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import {
  deleteBranchHead,
  getBranchHead,
  readyKnowledgeHeads,
} from "../models/knowledge-state.js"
import { createLogger, withLogger } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { knowledgeMaintenance } from "../openworkflow/workflows/knowledge-maintenance.js"
import { knowledgeProjection } from "../openworkflow/workflows/knowledge-projection.js"
import { textEmbeddingConfig } from "../retrieval/embeddings/textEmbeddings.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import { cleanUpKnowledgePlane } from "./cleanup.js"
import { projectKnowledgePlane } from "./writer.js"

/*
 * Faults of ClickHouse under the knowledge plane (CTX-1519). In CTX-1007, a
 * FalkorDB restart during a bulk graph cleanup left one org graph that
 * refused each projection query, the hydrates looped, and only a person
 * could repair it. These tests give the same faults to the plane, with real
 * collaborators: a real Git remote (`file://`), Postgres, ClickHouse of the
 * pinned image (restarted for real), and a real OpenWorkflow worker. msw
 * answers the embedding API.
 */

const here = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(here, "../../.env.local"), quiet: true })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_kfault_${suffix}`
const MODEL_URL = "https://embeddings.test/api/v1"
const contentTables = [
  "documents",
  "chunks",
  "relations",
  "relations_in",
  "doc_refs",
] as const

const msw = setupServer(
  http.post(`${MODEL_URL}/embeddings`, async ({ request }) => {
    const body = (await request.json()) as { input: string[] }
    return HttpResponse.json({
      data: body.input.map((_, index) => ({
        index,
        embedding: Array(textEmbeddingConfig.dimensions).fill(0.01),
      })),
    })
  }),
)

let clickhouse: Awaited<ReturnType<typeof startClickHouse>>
let admin: ClickHouseClient
let writerUrl: string
let store: KnowledgeStore
const workspaceIds: string[] = []
const remotes: Remote[] = []

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb()
    .insert(organizations)
    .values({
      id: orgId,
      slug: orgId.replaceAll("_", "-"),
      name: "Knowledge faults",
      createdAt: new Date(),
    })
  await withOrgDbContext(orgId, (db) =>
    db.insert(orgFeatures).values({
      organizationId: orgId,
      feature: "knowledge_plane",
      value: "shadow",
    }),
  )
  msw.listen({ onUnhandledRequest: "bypass" })
  clickhouse = await startClickHouse()
  const adminUrl = await clickhouse.freshDatabase()
  // The writer user of the worker (ADR-066 decision 9).
  await migrateKnowledgeStore(adminUrl, {
    reader: "reader-test",
    writer: "writer-test",
  })
  admin = clickhouse.client(adminUrl)
  writerUrl = userUrl(adminUrl, "ctxpipe_writer", "writer-test")
  store = createKnowledgeStore(writerUrl)
}, 240_000)

afterAll(async () => {
  msw.close()
  await store?.close()
  await clickhouse?.stop()
  for (const remote of remotes) await remote.remove()
  for (const workspaceId of workspaceIds)
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
    )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_URL", MODEL_URL)
  return () => vi.unstubAllEnvs()
})

/** A Git repository that a shallow fetch by SHA can read. */
class Remote {
  private constructor(readonly directory: string) {}

  static async create(): Promise<Remote> {
    const remote = new Remote(await mkdtemp(join(tmpdir(), "knowledge-fault-")))
    remotes.push(remote)
    remote.git("init", "-q", "-b", "main")
    remote.git("config", "uploadpack.allowAnySHA1InWant", "true")
    remote.git("config", "uploadpack.allowFilter", "true")
    return remote
  }

  get url(): string {
    return pathToFileURL(this.directory).toString()
  }

  git(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-C",
        this.directory,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim()
  }

  /** Write each file on the checked-out branch, commit, and give the SHA. */
  async commit(files: Record<string, string>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(this.directory, path)), { recursive: true })
      await writeFile(join(this.directory, path), content)
      this.git("add", path)
    }
    this.git("commit", "-q", "-m", "change")
    return this.git("rev-parse", "HEAD")
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
  }
}

/** 20 linked documents, so that each file version has relations. */
const documents = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [
    `docs/d${i}.md`,
    `# Doc ${i}\n\nSee [the next one](d${i + 1}.md) and [the guide](../guide.md).\n`,
  ]),
)

/** A Workspace row in Postgres, at `tip` of `remote`. */
async function newWorkspace(remote: Remote, tip: string): Promise<string> {
  const workspaceId = `ws_test_kfault_${workspaceIds.length}_${suffix}`
  workspaceIds.push(workspaceId)
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: workspaceId.replaceAll("_", "-"),
      displayName: "Knowledge faults",
      workspaceRepositoryUrl: remote.url,
      desiredDefaultBranch: "main",
      desiredSha: tip,
    }),
  )
  return workspaceId
}

/** One run of the writer, as the projection workflow starts it. */
function project(
  workspaceId: string,
  remote: Remote,
  tip: string,
  options: { overlay?: string; defaultTip?: string; rebuild?: boolean } = {},
) {
  return withLogger(createLogger({}), () =>
    projectKnowledgePlane({
      orgId,
      workspaceId,
      remote: { url: remote.url, token: async () => undefined },
      root: "",
      branch: options.overlay ?? "main",
      defaultTip: options.defaultTip ?? null,
      tip,
      store,
      observedAt: new Date(),
      ...(options.rebuild ? { rebuild: true } : {}),
    }),
  )
}

/** The cleanup of a Workspace at `now`. */
function cleanUp(workspaceId: string, now: Date) {
  return withLogger(createLogger({}), () =>
    cleanUpKnowledgePlane({ orgId, workspaceId, store, now }),
  )
}

/** The document keys that a read of the default branch shows, with their status. */
async function view(workspaceId: string): Promise<Record<string, string>> {
  const head = (await readyKnowledgeHeads(orgId, [workspaceId])).get(
    workspaceId,
  )
  if (!head) return {}
  return Object.fromEntries(
    (
      await store.listDocumentStatuses({
        orgId,
        heads: [{ workspaceId, ...head }],
      })
    ).map((row) => [row.docKey, row.status]),
  )
}

/** The count of `active` documents of a view. */
const active = (documents: Record<string, string>) =>
  Object.values(documents).filter((status) => status === "active").length

/** A statement of the admin user on the rows of one Workspace. */
async function adminCount(query: string, workspaceId: string): Promise<number> {
  const [row] = await (
    await admin.query({
      query,
      query_params: { orgId, workspaceId },
      format: "JSONEachRow",
      clickhouse_settings: { [ORG_SETTING]: orgId },
    })
  ).json<{ count: string }>()
  return Number(row?.count ?? 0)
}

/** The tables with a mutation that is not done. */
async function pendingMutations(): Promise<string[]> {
  return (
    await (
      await admin.query({
        query:
          "SELECT table FROM system.mutations WHERE database = currentDatabase() AND NOT is_done",
        format: "JSONEachRow",
      })
    ).json<{ table: string }>()
  ).map((row) => row.table)
}

it(
  "a ClickHouse restart in the middle of a cleanup of many old branch trees keeps the reads whole, and the next run and cleanup complete",
  { timeout: 240_000 },
  async () => {
    const remote = await Remote.create()
    const first = await remote.commit({
      ...documents,
      "guide.md": "# Guide\n",
    })
    const workspaceId = await newWorkspace(remote, first)
    await project(workspaceId, remote, first)
    // Old branch trees: 6 branches with file versions of their own, which
    // Git then deletes. The run of a deleted branch deletes its head.
    for (let n = 0; n < 6; n++) {
      remote.git("checkout", "-q", "-b", `topic-${n}`, first)
      const tip = await remote.commit({
        [`docs/d${n}.md`]: `# Topic ${n}\n\nSee [the guide](../guide.md).\n`,
        [`topic/t${n}.md`]: `# Topic note ${n}\n\nSee [doc](../docs/d${n}.md).\n`,
      })
      remote.git("checkout", "-q", "main")
      remote.git("branch", "-q", "-D", `topic-${n}`)
      await project(workspaceId, remote, tip, {
        overlay: `topic-${n}`,
        defaultTip: first,
      })
      await deleteBranchHead({ orgId, workspaceId, branch: `topic-${n}` })
    }
    // A new tip of the default branch replaces 5 files: replaced tree rows
    // and unused file versions.
    const second = await remote.commit(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `docs/d${i + 10}.md`,
          `# Doc ${i + 10}, second\n\nSee [the guide](../guide.md).\n`,
        ]),
      ),
    )
    await project(workspaceId, remote, second)
    const before = await view(workspaceId)
    expect(active(before)).toBe(21)
    // After the grace times of the cleanup.
    const later = new Date(Date.now() + 2 * 24 * 60 * 60_000)

    // With the merges of `relations` stopped, the DELETE of the unused
    // relations stays a pending mutation: the cleanup has deleted the tree
    // rows of the old branches and the unused document rows, and it waits
    // for that mutation. Then ClickHouse restarts (a kill, then a start).
    await admin.command({ query: "SYSTEM STOP MERGES relations" })
    const cleanup = cleanUp(workspaceId, later)
    cleanup.catch(() => undefined)
    await vi.waitFor(
      async () => expect(await pendingMutations()).toContain("relations"),
      { timeout: 60_000, interval: 100 },
    )
    await clickhouse.restart()
    await expect(cleanup).rejects.toThrow()

    // The reads answer and show the same view: the cleanup deleted no row
    // that the head shows. The merges run again after the restart, so the
    // mutation that the restart cut completes by itself.
    expect(await view(workspaceId)).toEqual(before)
    await vi.waitFor(async () => expect(await pendingMutations()).toEqual([]), {
      timeout: 60_000,
      interval: 200,
    })

    // The next run and its cleanup complete, and the cleanup deletes the
    // rest of the cut work.
    const third = await remote.commit({ "docs/d19.md": "# Doc 19, third\n" })
    expect(await project(workspaceId, remote, third)).toMatchObject({
      mode: "delta",
      documentsChanged: 1,
    })
    const after = await view(workspaceId)
    expect(active(after)).toBe(21)
    await cleanUp(workspaceId, later)
    expect(await view(workspaceId)).toEqual(after)
    const scoped =
      "org_id = {orgId:String} AND workspace_id = {workspaceId:String}"
    expect(
      await adminCount(
        `SELECT count() AS count FROM trees WHERE ${scoped} AND branch != 'main'`,
        workspaceId,
      ),
    ).toBe(0)
    for (const table of ["documents", "chunks"])
      expect(
        await adminCount(
          `SELECT count() AS count FROM ${table} WHERE ${scoped}
             AND (doc_key, version) NOT IN (
               SELECT doc_key, version FROM trees WHERE ${scoped})`,
          workspaceId,
        ),
      ).toBe(0)
    expect(
      await adminCount(
        `SELECT count() AS count FROM relations WHERE ${scoped}
           AND (src_doc, src_version) NOT IN (
             SELECT doc_key, version FROM trees WHERE ${scoped})`,
        workspaceId,
      ),
    ).toBe(0)
  },
)

it(
  "when ClickHouse refuses each write of one Workspace, its run stops after its retries, and the other Workspace keeps projecting with a normal event loop",
  { timeout: 300_000 },
  async () => {
    const goodRemote = await Remote.create()
    const goodTip = await goodRemote.commit(documents)
    const good = await newWorkspace(goodRemote, goodTip)
    const badRemote = await Remote.create()
    const badTip = await badRemote.commit(documents)
    const bad = await newWorkspace(badRemote, badTip)
    vi.stubEnv("CLICKHOUSE_URL", writerUrl)

    // ClickHouse refuses each row of the broken Workspace (a CHECK
    // constraint, as for a tenant whose writes the server refuses).
    const written = ["documents", "chunks", "trees"]
    for (const table of written)
      await admin.command({
        query: `ALTER TABLE ${table} ADD CONSTRAINT broken_tenant CHECK workspace_id != '${bad}'`,
      })
    const namespaceId = openWorkflowNamespaceId()
    const backend = await BackendPostgres.connect(
      process.env.DATABASE_URL ?? "",
      { runMigrations: false, namespaceId },
    )
    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(knowledgeProjection.spec, knowledgeProjection.fn)
    runner.implementWorkflow(knowledgeMaintenance.spec, knowledgeMaintenance.fn)
    const worker = runner.newWorker({ concurrency: 2 })
    const delay = monitorEventLoopDelay({ resolution: 10 })
    // The retry policy of the step waits 10 s, then doubles the wait (5 min
    // in all). The test moves each retry of the broken run to now, as a
    // clock that runs fast.
    const skipWait = setInterval(() => {
      void getSystemDb()
        .execute(
          sql`update openworkflow.workflow_runs set available_at = now()
            where namespace_id = ${namespaceId}
              and workflow_name = 'knowledge-projection'
              and status = 'pending' and available_at > now()
              and input->>'workspaceId' = ${bad}`,
        )
        .catch(() => undefined)
    }, 200)
    try {
      await worker.start()
      delay.enable()
      await runner.runWorkflow(knowledgeProjection.spec, {
        orgId,
        workspaceId: bad,
      })
      await runner.runWorkflow(knowledgeProjection.spec, {
        orgId,
        workspaceId: good,
      })
      await vi.waitFor(
        async () =>
          expect(await projectionRuns()).toEqual([
            { workspaceId: good, status: "completed" },
            { workspaceId: bad, status: "failed" },
          ]),
        { timeout: 240_000, interval: 500 },
      )
      delay.disable()

      // The other Workspace projected all of its documents.
      expect(active(await view(good))).toBe(20)
      // The broken run made the 6 attempts of its retry policy, and then it
      // stopped: no other run of it was queued. Its head is `failed`.
      const attempts = await getSystemDb().execute<{ count: number }>(
        sql`select count(*)::int as count from openworkflow.step_attempts s
          join openworkflow.workflow_runs r
            on r.id = s.workflow_run_id and r.namespace_id = s.namespace_id
          where r.namespace_id = ${namespaceId}
            and r.input->>'workspaceId' = ${bad}
            and s.step_name = 'project-knowledge-plane'
            and s.status = 'failed'`,
      )
      expect(attempts.rows[0]?.count).toBe(6)
      expect(
        await getBranchHead({ orgId, workspaceId: bad, branch: "main" }),
      ).toMatchObject({ runStatus: "failed" })
      // The event loop of the worker stayed free: in CTX-1007 a loop held
      // it at 100%, with a delay of up to 35 s.
      expect(delay.max / 1e6).toBeLessThan(1_000)

      // When ClickHouse takes the writes again, the next run of the broken
      // Workspace (the next hydrate queues it) completes: the run left no
      // lease and no state that blocks it.
      for (const table of written)
        await admin.command({
          query: `ALTER TABLE ${table} DROP CONSTRAINT broken_tenant`,
        })
      const next = await runner.runWorkflow(knowledgeProjection.spec, {
        orgId,
        workspaceId: bad,
      })
      expect(await next.result({ timeoutMs: 60_000 })).toMatchObject({
        summary: { mode: "full" },
      })
      expect(active(await view(bad))).toBe(20)
    } finally {
      clearInterval(skipWait)
      delay.disable()
      await worker.stop()
      await backend.stop()
      for (const table of written)
        await admin
          .command({
            query: `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS broken_tenant`,
          })
          .catch(() => undefined)
    }

    async function projectionRuns() {
      return (
        await getSystemDb().execute<{ workspaceId: string; status: string }>(
          sql`select input->>'workspaceId' as "workspaceId", status
            from openworkflow.workflow_runs
            where namespace_id = ${namespaceId}
              and workflow_name = 'knowledge-projection'
              and input->>'workspaceId' in (${good}, ${bad})
            order by input->>'workspaceId' = ${bad}, created_at`,
        )
      ).rows
    }
  },
)

it(
  "after all plane rows of a Workspace are lost, the next run rebuilds the tree in full from Git, at the same tip and at a new tip",
  { timeout: 180_000 },
  async () => {
    const remote = await Remote.create()
    const tip = await remote.commit({ ...documents, "guide.md": "# Guide\n" })
    const workspaceId = await newWorkspace(remote, tip)
    await project(workspaceId, remote, tip)
    const before = await view(workspaceId)
    expect(active(before)).toBe(21)
    const loseAllRows = async () => {
      for (const table of [...contentTables, "trees"])
        await admin.command({
          query: `DELETE FROM ${table} WHERE org_id = {orgId:String} AND workspace_id = {workspaceId:String}`,
          query_params: { orgId, workspaceId },
          clickhouse_settings: { lightweight_deletes_sync: "2" },
        })
      expect(await view(workspaceId)).toEqual({})
    }

    // At the same tip, the head says `current`, but its tree is empty.
    await loseAllRows()
    expect(await project(workspaceId, remote, tip)).toMatchObject({
      mode: "full",
      fullReason: "empty_tree",
    })
    expect(await view(workspaceId)).toEqual(before)
    expect(await project(workspaceId, remote, tip)).toEqual({
      mode: "current",
    })

    // At a new tip, a delta would write only the changed file.
    await loseAllRows()
    const next = await remote.commit({ "docs/d0.md": "# Doc 0, next\n" })
    expect(await project(workspaceId, remote, next)).toMatchObject({
      mode: "full",
      fullReason: "empty_tree",
    })
    expect(Object.keys(await view(workspaceId)).sort()).toEqual(
      Object.keys(before).sort(),
    )
  },
)

it(
  "a rebuild that an operator asks for (`rebuild: true`) repairs a partial loss that a run cannot see",
  { timeout: 120_000 },
  async () => {
    const remote = await Remote.create()
    const tip = await remote.commit({ ...documents, "guide.md": "# Guide\n" })
    const workspaceId = await newWorkspace(remote, tip)
    await project(workspaceId, remote, tip)
    // The documents whose file version a read finds: a read joins the
    // document row of the file version, and a lost row gives no title.
    const readable = async () => {
      const head = (await readyKnowledgeHeads(orgId, [workspaceId])).get(
        workspaceId,
      )
      if (!head) return 0
      return (
        await store.readDocuments(
          { orgId, heads: [{ workspaceId, ...head }] },
          Object.keys(await view(workspaceId)).map((docKey) => ({
            workspaceId,
            docKey,
          })),
        )
      ).filter(({ document }) => document.title !== "").length
    }
    const before = await view(workspaceId)
    expect(await readable()).toBe(21)
    // The document rows of 11 files are lost; the tree rows stay.
    await admin.command({
      query: `DELETE FROM documents WHERE org_id = {orgId:String} AND workspace_id = {workspaceId:String} AND path LIKE 'docs/d1%'`,
      query_params: { orgId, workspaceId },
      clickhouse_settings: { lightweight_deletes_sync: "2" },
    })
    expect(await readable()).toBe(10)
    expect(await project(workspaceId, remote, tip)).toEqual({
      mode: "current",
    })

    expect(
      await project(workspaceId, remote, tip, { rebuild: true }),
    ).toMatchObject({ mode: "full", fullReason: "rebuild" })
    expect(await view(workspaceId)).toEqual(before)
    expect(await readable()).toBe(21)
  },
)
