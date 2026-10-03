import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { useMswServer } from "../../test/msw.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../db/schema/repositories.js"
import { createLogger, withLogger } from "../observability/logger.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgId = `org_follow_up_${suffix}`
const repositoryId = `repo_follow_up_${suffix}`
const codesearch = "http://codesearch.follow-up.test"
const tip = "b".repeat(40)

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.post(`${codesearch}/:repositoryId/resolve-ref`, () =>
    HttpResponse.json({ hash: tip, branch: "main" }),
  ),
)

describe("enqueueFollowUpIfTipAhead (Postgres)", () => {
  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error("DATABASE_URL is required")
    process.env.CODESEARCH_URL = codesearch
    initDb(connectionString)
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: "follow-up-fixture",
        gitUrl: `https://github.com/example/follow-up-${suffix}`,
      }),
    )
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
    )
    await withOrgDbContext(orgId, async (db) => {
      await db
        .delete(repositoryIngestionRequests)
        .where(eq(repositoryIngestionRequests.repositoryId, repositoryId))
      await db.delete(repositories).where(eq(repositories.id, repositoryId))
    })
    const { closeOpenWorkflowClient } = await import("./client.js")
    await closeOpenWorkflowClient()
    await closeDb()
  })

  it("admits the follow-up with the parent's request id, with no OTel context active", async () => {
    // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
    const { enqueueFollowUpIfTipAhead } = await import(
      "./enqueue-follow-up-if-tip-ahead.js"
    )
    const errors: Error[] = []
    const result = await withLogger(createLogger({ test: "follow-up" }), () =>
      enqueueFollowUpIfTipAhead(
        {
          orgId,
          repositoryId,
          ingestedHash: "a".repeat(40),
          requestId: "completed-request",
          telemetry: { "request.id": "req_parent_ingestion" },
        },
        { error: (error) => errors.push(error) },
      ),
    )
    expect(errors).toEqual([])
    expect(result).toMatchObject({ enqueued: true, tipHash: tip })
    const run = await getSystemDb().execute<{
      workflowName: string
      requestId: string | null
    }>(
      sql`select workflow_name as "workflowName", input->'telemetry'->>'request.id' as "requestId" from openworkflow.workflow_runs where id = ${result.workflowRunId ?? ""}`,
    )
    expect(run.rows[0]).toEqual({
      workflowName: "repository-ingestion-orchestrator",
      requestId: "req_parent_ingestion",
    })
  })
})
