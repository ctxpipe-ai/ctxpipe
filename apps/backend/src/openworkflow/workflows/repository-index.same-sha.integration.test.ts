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
import { repositories } from "../../db/schema/repositories.js"
import { generateObjectId } from "../../lib/id.js"
import { markRepositoryIndexingReady } from "../../models/repositories.js"
import { repositoryIndex } from "./repository-index.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), override: false })

const SHA = "de34390e40cd3a1160f130f50ad3a96374cc1838"
const NEWER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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

  it("rebuilds codesearch only when the published SHA changes", async () => {
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
  })
})
