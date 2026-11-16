import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { closeOpenWorkflowClient } from "../client.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { scheduleSweepsForOrgsNeedingIt } from "./conversation-sandbox-sweep.js"

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the sweep backstop")
  return url
}

beforeAll(() => {
  initDb(databaseUrl())
})

afterAll(async () => {
  await closeOpenWorkflowClient()
  await closeDb()
})

it("the worker starts of one hour queue one backstop sweep for each org, not one for each start (CTX-1305)", async () => {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Sweep backstop proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    })
    await db.insert(workspaceSandboxInstances).values({
      id: `stopped-${orgId}`,
      orgId,
      workspaceId,
      kind: "chat",
      conversationId: `conv_${orgId}`,
      provider: "docker",
      providerSandboxId: `container-${orgId}`,
      state: "stopped",
      lastHeartbeatAt: new Date(),
    })
  })
  const backend = await BackendPostgres.connect(databaseUrl(), {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  try {
    // Autoscaling starts and stops worker tasks many times in one hour.
    for (const start of ["09:07:12", "09:23:40", "09:41:05", "10:02:30"])
      await scheduleSweepsForOrgsNeedingIt(new Date(`2026-01-01T${start}Z`))
    const sweeps = (
      await backend.listWorkflowRuns({ limit: 1000 })
    ).data.filter(
      (run) =>
        run.workflowName === "conversation-sandbox-sweep" &&
        (run.input as { orgId?: string }).orgId === orgId,
    )
    try {
      expect(
        sweeps.map((run) => run.availableAt?.toISOString()).sort(),
      ).toEqual(["2026-01-01T09:00:00.000Z", "2026-01-01T10:00:00.000Z"])
    } finally {
      for (const run of sweeps)
        await backend.cancelWorkflowRun({ workflowRunId: run.id })
    }
  } finally {
    await backend.stop()
    await withOrgDbContext(orgId, async (db) => {
      await db
        .delete(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.orgId, orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
})
