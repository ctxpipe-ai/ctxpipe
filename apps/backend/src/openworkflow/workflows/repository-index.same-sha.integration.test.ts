import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../../test/db.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../../db/schema/repositories.js"
import { generateObjectId } from "../../lib/id.js"
import { markRepositoryIndexingReady } from "../../models/repositories.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { startPublishedRebuilds } from "./codesearch-checkout-gc.js"
import { repositoryIndex } from "./repository-index.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), override: false })

const SHA = "de34390e40cd3a1160f130f50ad3a96374cc1838"
const NEWER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const V2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const CODESEARCH = "http://codesearch.same-sha.test"

describeWithDatabase("repository-index same-SHA coalescing", () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const orgId = generateObjectId("org")
  const repositoryId = generateObjectId("repo")
  const namespace = `index_same_sha_${suffix}`
  const cloneCheckouts: string[] = []
  const server = setupServer(
    http.post(
      `${CODESEARCH}/:repositoryId/index/clone-checkout`,
      async ({ request }) => {
        const body = (await request.json()) as { targetHash: string }
        cloneCheckouts.push(body.targetHash)
        return HttpResponse.json({
          ok: true,
          targetHash: body.targetHash,
          ingestMode: "full",
          changedPaths: [],
          deletedPaths: [],
          renames: [],
        })
      },
    ),
    http.post(`${CODESEARCH}/:repositoryId/index/zoekt`, () =>
      HttpResponse.json({ ok: true }),
    ),
    http.post(`${CODESEARCH}/:repositoryId/index/detect-languages`, () =>
      HttpResponse.json({
        ok: true,
        detectedLanguages: [],
        languagesToIndex: [],
      }),
    ),
    http.post(`${CODESEARCH}/:repositoryId/index/merge-scip`, () =>
      HttpResponse.json({ ok: true, shardCount: 0 }),
    ),
  )
  let backend: BackendPostgres | undefined
  let worker: ReturnType<OpenWorkflow["newWorker"]> | undefined
  let runner: OpenWorkflow | undefined

  beforeAll(async () => {
    // The repository has no GitHub token, so the backend checks it as a
    // plain git URL (CTX-815). The test has its own DNS answer.
    usePlainGitNetwork({ lookup: async () => [{ address: "140.82.112.3" }] })
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) return
    vi.stubEnv("CODESEARCH_URL", CODESEARCH)
    server.listen({ onUnhandledRequest: "error" })
    initDb(databaseUrl)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgId,
        name: "Same-SHA index stampede",
        slug: `same-sha-index-${suffix}`,
        createdAt: new Date(),
      })
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: "stampede",
        gitUrl: "https://github.com/fixture/stampede.git",
      }),
    )
    backend = await BackendPostgres.connect(databaseUrl, {
      runMigrations: false,
      namespaceId: namespace,
    })
    runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
    worker = runner.newWorker({ concurrency: 1 })
    await worker.start()
  })

  afterAll(async () => {
    await worker?.stop()
    await backend?.stop()
    server.close()
    vi.unstubAllEnvs()
    if (!process.env.DATABASE_URL) return
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace} or input->>'orgId' = ${orgId}`,
    )
    await withOrgDbContext(orgId, (db) =>
      db.delete(repositories).where(eq(repositories.id, repositoryId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it(
    "rebuilds codesearch only when the published SHA changes",
    { timeout: 75_000 },
    async () => {
      if (!runner) throw new Error("OpenWorkflow runner missing")
      const activeRunner = runner
      const runIndex = async (targetHash: string) => {
        const handle = await activeRunner.runWorkflow(repositoryIndex.spec, {
          orgId,
          repositoryId,
          targetHash,
        })
        expect(await handle.result({ timeoutMs: 15_000 })).toMatchObject({
          targetHash,
          searchIndexOk: true,
        })
      }
      await runIndex(SHA)
      await withOrgDbContext(orgId, () =>
        markRepositoryIndexingReady({
          repositoryId,
          targetHash: SHA,
        }),
      )
      expect(cloneCheckouts).toEqual([SHA])
      await runIndex(SHA)
      expect(cloneCheckouts).toEqual([SHA])
      await withOrgDbContext(orgId, (db) =>
        db
          .update(repositories)
          .set({ indexingStatus: "queued" })
          .where(eq(repositories.id, repositoryId)),
      )
      await runIndex(SHA)
      expect(cloneCheckouts).toEqual([SHA, SHA])
      await runIndex(NEWER)
      expect(cloneCheckouts).toEqual([SHA, SHA, NEWER])
    },
  )

  it(
    "lets an ingestion v2 index run beside a legacy request, but stops a legacy run that has no request",
    { timeout: 45_000 },
    async () => {
      if (!runner) throw new Error("OpenWorkflow runner missing")
      // The legacy pipeline left a request for this repository. The v2 index
      // run is not a descendant of the request owner.
      await withOrgDbContext(orgId, (db) =>
        db.insert(repositoryIngestionRequests).values({
          repositoryId,
          orgId,
          requestId: generateObjectId("req"),
          repositoryUrl: "https://github.com/fixture/stampede.git",
          workflowRunId: `legacy_${suffix}`,
        }),
      )
      const legacy = await runner.runWorkflow(repositoryIndex.spec, {
        orgId,
        repositoryId,
        targetHash: V2,
      })
      await expect(legacy.result({ timeoutMs: 15_000 })).rejects.toThrow(
        "Repository ingestion request superseded",
      )
      const v2 = await runner.runWorkflow(repositoryIndex.spec, {
        orgId,
        repositoryId,
        targetHash: V2,
        ingestionV2: true,
      })
      expect(await v2.result({ timeoutMs: 15_000 })).toMatchObject({
        targetHash: V2,
        searchIndexOk: true,
      })
      expect(cloneCheckouts.at(-1)).toBe(V2)
      const [row] = await withOrgDbContext(orgId, (db) =>
        db
          .select({
            indexingStep: repositories.indexingStep,
            indexingStepKey: repositories.indexingStepKey,
          })
          .from(repositories)
          .where(eq(repositories.id, repositoryId)),
      )
      expect(row).toEqual({ indexingStep: null, indexingStepKey: null })
    },
  )

  it(
    "indexes the published SHA again for a rebuild, with no request and no status change",
    { timeout: 45_000 },
    async () => {
      if (!runner) throw new Error("OpenWorkflow runner missing")
      await withOrgDbContext(orgId, () =>
        markRepositoryIndexingReady({ repositoryId, targetHash: NEWER }),
      )
      const status = () =>
        withOrgDbContext(orgId, (db) =>
          db
            .select({
              indexingStatus: repositories.indexingStatus,
              lastIngestedHash: repositories.lastIngestedHash,
              indexingStepKey: repositories.indexingStepKey,
            })
            .from(repositories)
            .where(eq(repositories.id, repositoryId)),
        )
      const before = await status()
      const calls = cloneCheckouts.length

      const rebuild = await runner.runWorkflow(repositoryIndex.spec, {
        orgId,
        repositoryId,
        targetHash: NEWER,
        ingestionV2: true,
        rebuild: true,
      })
      expect(await rebuild.result({ timeoutMs: 15_000 })).toMatchObject({
        targetHash: NEWER,
        searchIndexOk: true,
      })
      expect(cloneCheckouts.slice(calls)).toEqual([NEWER])
      expect(await status()).toEqual(before)
    },
  )

  it("queues a codesearch-only index of each lost published revision", async () => {
    const hour = "2026-10-24T09"
    await startPublishedRebuilds([{ orgId, repositoryId, sha: NEWER }], hour)
    // The same hour queues no second run.
    await startPublishedRebuilds([{ orgId, repositoryId, sha: NEWER }], hour)
    const { rows } = await getSystemDb().execute<{ input: unknown }>(
      sql`select input from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
          and workflow_name = 'repository-index'
          and input->>'orgId' = ${orgId}`,
    )
    expect(rows.map((row) => row.input)).toEqual([
      expect.objectContaining({
        orgId,
        repositoryId,
        targetHash: NEWER,
        ingestionV2: true,
        rebuild: true,
      }),
    ])
  })
})
