import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../db/schema/repositories.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { enqueueRepositoryIngestionWorkflow } from "./enqueue-repository-ingestion.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_legacy_gate_${suffix}`
const workspaceId = `ws_test_legacy_gate_${suffix}`
const providers = ["linear", "notion", "slack", "pagerduty"] as const

async function startedRuns(repositoryId: string) {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.repositoryId, repositoryId)),
  )
  return rows.filter((row) => row.workflowRunId !== null)
}

describe("enqueueRepositoryIngestionWorkflow (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await getSystemDb().insert(organizations).values({
      id: orgId,
      slug: orgId,
      name: "Legacy gate",
      createdAt: new Date(),
    })
    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: workspaceId.replaceAll("_", "-"),
        displayName: "Legacy gate Workspace",
        workspaceRepositoryUrl: `https://github.com/acme/${workspaceId}.git`,
        desiredDefaultBranch: "main",
      }),
    )
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      await db.delete(repositories).where(eq(repositories.orgId, orgId))
      await db.delete(connections).where(eq(connections.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  async function seed(
    provider: (typeof providers)[number],
    withSources: boolean,
  ) {
    const connectionId = generateObjectId("con")
    const repositoryId = generateObjectId("repo")
    await withOrgDbContext(orgId, async (db) => {
      await db
        .insert(connections)
        .values({ id: connectionId, orgId, type: provider, config: {} })
      await db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: `acme/${repositoryId}`,
        gitUrl: `https://github.com/acme/${repositoryId}.git`,
        indexingStatus: "ready",
      })
      if (withSources) {
        await db.insert(workspaceSources).values({
          id: generateObjectId("wsrc"),
          orgId,
          workspaceId,
          sourceKey: `${provider}-${connectionId}`,
          connectionId,
          provider,
          scope: {},
          status: "ok",
          revision: "a".repeat(40),
        })
      }
    })
    return { connectionId, repositoryId }
  }

  for (const provider of providers) {
    it(`${provider}: a connection with Workspace sources starts no run`, async () => {
      const { connectionId, repositoryId } = await seed(provider, true)
      const result = await enqueueRepositoryIngestionWorkflow(
        {
          orgId,
          repositoryId,
          legacySyncConnectionId: connectionId,
          targetBranch: "main",
        },
        { error: () => {} },
      )
      expect(result).toBeNull()
      expect(await startedRuns(repositoryId)).toEqual([])
    })

    it(`${provider}: a connection without sources still starts one run`, async () => {
      const { connectionId, repositoryId } = await seed(provider, false)
      const result = await enqueueRepositoryIngestionWorkflow(
        {
          orgId,
          repositoryId,
          legacySyncConnectionId: connectionId,
          targetBranch: "main",
        },
        { error: () => {} },
      )
      expect(result?.workflowRunId).toEqual(expect.any(String))
      expect(await startedRuns(repositoryId)).toHaveLength(1)
    })
  }

  it("does not treat the sources of another connection as a gate", async () => {
    const gated = await seed("linear", true)
    const other = await seed("linear", false)
    const result = await enqueueRepositoryIngestionWorkflow(
      {
        orgId,
        repositoryId: gated.repositoryId,
        legacySyncConnectionId: other.connectionId,
        targetBranch: "main",
      },
      { error: () => {} },
    )
    expect(result).not.toBeNull()
  })
})
