import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import { generateObjectId } from "../../../lib/id.js"
import { createLogger, withLogger } from "../../../observability/logger.js"
import { closeOpenWorkflowClient } from "../../../openworkflow/client.js"
import { enqueueKnowledgeBranchRuns } from "./github-knowledge-branch-push.js"

/*
 * The trigger of the projection of a branch (ADR-071 decision 7) against a
 * real Postgres: a push to a branch that is not the default branch queues a
 * `knowledge-projection` run of that branch, for each org of the push, with
 * a key that holds the pushed SHA.
 */

const orgA = generateObjectId("org")
const orgB = generateObjectId("org")
const workspaceOf = {
  [orgA]: generateObjectId("ws"),
  [orgB]: generateObjectId("ws"),
}
const repository = "example-org/notes"

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  for (const orgId of [orgA, orgB]) {
    await getSystemDb().insert(organizations).values({
      id: orgId,
      slug: orgId,
      name: "Knowledge branch push",
      createdAt: new Date(),
    })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceOf[orgId] as string,
        orgId,
        slug: `notes-${orgId}`,
        displayName: "Notes",
        workspaceRepositoryUrl: `https://github.com/${repository}.git`,
        desiredDefaultBranch: "main",
      })
    })
  }
})

afterAll(async () => {
  for (const orgId of [orgA, orgB]) {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
    )
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
  await closeOpenWorkflowClient()
  await closeDb()
})

/** The input of each queued knowledge-projection run of the two orgs. */
async function queued() {
  const rows = (
    await getSystemDb().execute(
      sql`select input from openworkflow.workflow_runs
        where workflow_name = 'knowledge-projection'
          and input->>'orgId' in (${orgA}, ${orgB})
        order by created_at`,
    )
  ).rows as { input: Record<string, unknown> }[]
  return rows.map((row) => row.input)
}

const zero = "0".repeat(40)
const push = (ref: string, deliveryId: string, after = "b".repeat(40)) =>
  withLogger(createLogger({}), () =>
    enqueueKnowledgeBranchRuns({
      orgIds: [orgA, orgB],
      // GitHub can give the name in another case.
      repository: "Example-Org/Notes",
      ref,
      deliveryId,
      before: zero,
      after,
    }),
  )

it("queues one run of the pushed branch for each push and each org, and none for the default branch or a tag", async () => {
  const runs = [orgA, orgB].map((orgId) => ({
    orgId,
    workspaceId: workspaceOf[orgId],
    branch: "feature",
  }))
  await push("refs/heads/main", "delivery-1")
  await push("refs/tags/v1", "delivery-2")
  expect(await queued()).toEqual([])

  await push("refs/heads/feature", "delivery-3")
  // A redelivery of the same push queues no second run.
  await push("refs/heads/feature", "delivery-3")
  expect(await queued()).toEqual(runs)

  // The push that deletes the branch queues a run too: it removes the head.
  await push("refs/heads/feature", "delivery-4", zero)
  expect(await queued()).toEqual([...runs, ...runs])
  // Each later push queues its own run, also one with the same SHAs as an
  // earlier push (the branch comes back and is deleted again).
  await push("refs/heads/feature", "delivery-5")
  await push("refs/heads/feature", "delivery-6", zero)
  expect(await queued()).toHaveLength(8)
})
