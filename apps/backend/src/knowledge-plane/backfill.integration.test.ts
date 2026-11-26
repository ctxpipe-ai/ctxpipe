import { eq, sql } from "drizzle-orm"
import { initLogger } from "evlog"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../models/knowledge-state.js"
import { closeOpenWorkflowClient } from "../openworkflow/client.js"
import { backfillKnowledgePlane } from "./backfill.js"

/*
 * The backfill of an org (CTX-1643), with a real Postgres and the real
 * OpenWorkflow tables. No worker runs here; the test reads the queued runs.
 */

const orgId = generateObjectId("org")
const ready = generateObjectId("ws")
const fresh = generateObjectId("ws")
const noTip = generateObjectId("ws")
const events: Record<string, unknown>[] = []

async function projectionRuns() {
  const result = await getSystemDb().execute<{
    input: Record<string, unknown>
  }>(sql`
    select input from openworkflow.workflow_runs
    where workflow_name = 'knowledge-projection'
      and input->>'orgId' = ${orgId}
    order by created_at
  `)
  return result.rows.map((row) => row.input.workspaceId)
}

async function completeDefaultRun(workspaceId: string, tip = "a".repeat(40)) {
  const key = { orgId, workspaceId, branch: "main" }
  await beginKnowledgeRun({ ...key, isDefault: true })
  await completeKnowledgeRun({
    ...key,
    tip,
    treeVersion: 1,
    baseBranch: null,
    projectionVersion: "1:test-model",
    failedCount: 0,
  })
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the backfill")
  initDb(url)
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
    drain: (ctx) => {
      events.push(ctx.event)
    },
  })
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Backfill proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values(
      [ready, fresh, noTip].map((id) => ({
        id,
        orgId,
        slug: id.replaceAll("_", "-"),
        displayName: "Backfill proof",
        workspaceRepositoryUrl: `https://github.com/example/${id}.git`,
        desiredDefaultBranch: "main",
        desiredSha: id === noTip ? null : "a".repeat(40),
      })),
    ),
  )
  await completeDefaultRun(ready)
})

afterAll(async () => {
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
  )
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeOpenWorkflowClient()
  await closeDb()
})

describe("the knowledge plane backfill", () => {
  it("queues one run for each Workspace with a tip and no ready head, on each call, until it is ready", async () => {
    await expect(backfillKnowledgePlane(orgId)).resolves.toEqual([fresh])
    expect(await projectionRuns()).toEqual([fresh])
    const backfill = events.find(
      (event) => event.step === "knowledge_plane.backfill",
    )
    expect(backfill).toMatchObject({
      orgId,
      count: 1,
      workspaceIds: [fresh],
    })
    expect(JSON.stringify(backfill)).not.toContain("Backfill proof")

    // The first run failed: the next deploy queues it again.
    await backfillKnowledgePlane(orgId)
    expect(await projectionRuns()).toEqual([fresh, fresh])

    await completeDefaultRun(fresh)
    await expect(backfillKnowledgePlane(orgId)).resolves.toEqual([])
    expect(await projectionRuns()).toHaveLength(2)
  })

  it("queues a Workspace whose ready head is at an earlier tip, until a run applies the tip", async () => {
    // A commit while the org had the flag `off`: no run applied it, and the
    // head of the earlier tip stayed ready.
    const tip = "b".repeat(40)
    await withOrgDbContext(orgId, (db) =>
      db
        .update(workspaces)
        .set({ desiredSha: tip })
        .where(eq(workspaces.id, ready)),
    )
    await expect(backfillKnowledgePlane(orgId)).resolves.toEqual([ready])

    await completeDefaultRun(ready, tip)
    await expect(backfillKnowledgePlane(orgId)).resolves.toEqual([])
  })
})
