import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  getWorkspaceProjection,
  updateWorkspace,
} from "../../models/workspaces.js"
import type { WorkspaceRevision } from "./revision.js"

it("a connection-only relink creates a new desired generation and preserves the published revision", async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required")
  initDb(process.env.DATABASE_URL)
  const org = {
    id: generateObjectId("org"),
    slug: generateObjectId("slug"),
    name: "Relink proof",
  }
  const connectionId = generateObjectId("con")
  const revision: WorkspaceRevision = {
    workspaceId: generateObjectId("ws"),
    generation: 3,
    remote: {
      url: "https://example.test/context.git",
      connectionId: connectionId,
    },
    sha: "a".repeat(40),
    defaultBranch: "main",
    access: "read",
  }
  try {
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgDbContext(org.id, async (db) => {
      await db
        .insert(connections)
        .values({ id: connectionId, orgId: org.id, type: "github", config: {} })
      await db.insert(workspaces).values({
        id: revision.workspaceId,
        orgId: org.id,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: revision.remote.url,
        githubConnectionId: connectionId,
        desiredGeneration: 3,
        desiredSha: revision.sha,
        desiredDefaultBranch: "main",
        activeRevision: revision,
        activeProjectionSha: revision.sha,
        activeProjectionUrl: revision.remote.url,
        hydrateStatus: "ready",
      })
    })
    await withOrgIdContext(org, async () => {
      const updated = await updateWorkspace("context", {
        githubConnectionId: null,
      })
      expect(updated).toMatchObject({
        desiredGeneration: 4,
        desiredSha: null,
        desiredDefaultBranch: null,
        githubConnectionId: null,
        hydrateStatus: "pending",
      })
      expect(await getWorkspaceProjection(revision.workspaceId)).toMatchObject({
        kind: "building",
        previous: { kind: "active", revision },
      })
    })
  } finally {
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, revision.workspaceId))
      await db.delete(connections).where(eq(connections.id, connectionId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
    await closeDb()
  }
})
