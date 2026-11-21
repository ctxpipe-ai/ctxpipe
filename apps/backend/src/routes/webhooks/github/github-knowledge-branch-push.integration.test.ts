import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import { orgFeatures } from "../../../db/schema/org_features.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import { generateObjectId } from "../../../lib/id.js"
import { createLogger, withLogger } from "../../../observability/logger.js"
import { closeOpenWorkflowClient } from "../../../openworkflow/client.js"
import { enqueueKnowledgeBranchRuns } from "./github-knowledge-branch-push.js"

/*
 * The trigger of the projection of a branch (ADR-071 decision 7) against a
 * real Postgres: a push to a branch that is not the default branch queues a
 * `knowledge-projection` run of that branch, for each org whose flag is not
 * `off`, with a key that holds the pushed SHA.
 */

const on = generateObjectId("org")
const off = generateObjectId("org")
const workspaceId = generateObjectId("ws")
const repository = "example-org/notes"

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  for (const orgId of [on, off]) {
    await getSystemDb().insert(organizations).values({
      id: orgId,
      slug: orgId,
      name: "Knowledge branch push",
      createdAt: new Date(),
    })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: orgId === on ? workspaceId : generateObjectId("ws"),
        orgId,
        slug: `notes-${orgId}`,
        displayName: "Notes",
        workspaceRepositoryUrl: `https://github.com/${repository}.git`,
        desiredDefaultBranch: "main",
      })
      await db.insert(orgFeatures).values({
        organizationId: orgId,
        feature: "knowledge_plane",
        value: orgId === on ? "on" : "off",
      })
    })
  }
})

afterAll(async () => {
  for (const orgId of [on, off]) {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
    )
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(orgFeatures).where(eq(orgFeatures.organizationId, orgId))
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
          and input->>'orgId' in (${on}, ${off})
        order by created_at`,
    )
  ).rows as { input: Record<string, unknown> }[]
  return rows.map((row) => row.input)
}

const push = (ref: string, after: string) =>
  withLogger(createLogger({}), () =>
    enqueueKnowledgeBranchRuns({
      orgIds: [on, off],
      // GitHub can give the name in another case.
      repository: "Example-Org/Notes",
      ref,
      after,
    }),
  )

it("queues one run of the pushed branch for each org that has the plane, and none for the default branch or a tag", async () => {
  await push("refs/heads/main", "a".repeat(40))
  await push("refs/tags/v1", "a".repeat(40))
  expect(await queued()).toEqual([])

  await push("refs/heads/feature", "b".repeat(40))
  // A redelivery of the same push queues no second run.
  await push("refs/heads/feature", "b".repeat(40))
  expect(await queued()).toEqual([
    { orgId: on, workspaceId, branch: "feature" },
  ])

  // The push that deletes the branch queues a run too: it removes the head.
  await push("refs/heads/feature", "0".repeat(40))
  expect(await queued()).toEqual([
    { orgId: on, workspaceId, branch: "feature" },
    { orgId: on, workspaceId, branch: "feature" },
  ])
})
