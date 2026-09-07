import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  getWorkspaceById,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"

it.each([0, 1, 100])(
  "executes the hydrate workflow for %i native-git files and persists its PostgreSQL result",
  { timeout: 60_000 },
  async (count) => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for hydration proof")
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-hydration-contract-"))
    const id = `hydrate_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const org = { id: `org_${id}`, slug: id, name: "Hydration contract" }
    const workspaceId = `ws_${id}`
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    const savedEnv = {
      MODEL_PROVIDER: process.env.MODEL_PROVIDER,
      MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY,
      MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL,
    }
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "fixture-only",
      MODEL_PROVIDER_URL: "https://hydrate-model.test/v1",
    })
    const server = setupServer(
      http.post(
        "https://hydrate-model.test/v1/embeddings",
        async ({ request }) => {
          const body = (await request.json()) as { input: string[] }
          return HttpResponse.json({
            data: body.input.map((_, index) => ({
              index,
              embedding: Array(2000).fill(0.01),
            })),
          })
        },
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    initDb(databaseUrl)
    const backend = await BackendPostgres.connect(databaseUrl, {
      runMigrations: false,
      namespaceId: id,
    })
    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
    const worker = runner.newWorker({ concurrency: 1 })
    try {
      git("init", "-b", "main")
      const expected = Array.from({ length: count }, (_, index) => ({
        path: `document-${String(index).padStart(3, "0")}.md`,
        body: `# Document ${index}\nCommitted body ${index}.\n`,
      }))
      for (const file of expected)
        writeFileSync(join(directory, file.path), file.body)
      git("add", ".")
      git(
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Immutable fixture",
      )
      const sha = git("rev-parse", "HEAD")
      const remote = join(directory, "remote.git")
      git("clone", "--bare", directory, remote)
      for (const file of expected)
        writeFileSync(join(directory, file.path), "Uncommitted replacement\n")
      await getSystemDb()
        .insert(organizations)
        .values({ ...org, createdAt: new Date() })
      await withOrgDbContext(org.id, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId: org.id,
          slug: id,
          displayName: org.name,
          workspaceRepositoryUrl: remote,
          desiredSha: sha,
          desiredGeneration: 1,
          indexedSha: sha,
        }),
      )
      const handle = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
      })
      await worker.start()
      expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
        hydrated: true,
        units: count,
        skipped: 0,
      })
      const run = await backend.getWorkflowRun({
        workflowRunId: handle.workflowRun.id,
      })
      expect(run?.status).toBe("completed")
      await withOrgIdContext(org, async () => {
        const projection = await listWorkspaceKnowledgeUnits(workspaceId)
        expect(
          projection.units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expected)
        const workspace = await getWorkspaceById(workspaceId)
        expect(workspace?.activeProjectionSha).toBe(sha)
        expect(workspace?.hydratePhases?.embeddings).toBe(true)
      })
    } finally {
      await worker.stop()
      await backend.stop()
      try {
        await getSystemDb().execute(
          sql`delete from openworkflow.workflow_runs where namespace_id = ${id}`,
        )
        await withOrgDbContext(org.id, (db) =>
          db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
        )
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, org.id))
      } finally {
        await closeDb()
        server.close()
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)
