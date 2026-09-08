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
import {
  workspaces,
  workspaceLinkedRepositories,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  getLinkedReadBinding,
  persistLinkedDesiredSha,
} from "../../models/workspaces.js"
import { repositories } from "../../db/schema/repositories.js"
import type { WorkspaceRevision } from "./revision.js"

it.each([
  "unchanged",
  "ref",
  "owner",
  "connection",
] as const)("fences linked tip publication against captured %s identity", async (change) => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required")
  initDb(process.env.DATABASE_URL)
  const org = {
    id: generateObjectId("org"),
    slug: generateObjectId("slug"),
    name: "Relink proof",
  }
  const connectionId = generateObjectId("con")
  const repositoryId = generateObjectId("repo")
  const linkedId = generateObjectId("wlr")
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
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: org.id,
        name: "Linked",
        gitUrl: "https://example.test/linked.git",
        githubConnectionId: connectionId,
      })
      await db.insert(workspaceLinkedRepositories).values({
        id: linkedId,
        orgId: org.id,
        workspaceId: revision.workspaceId,
        gitUrl: "https://example.test/linked.git",
        desiredRef: "main",
        desiredSha: "b".repeat(40),
      })
    })
    await withOrgIdContext(org, async () => {
      const binding = await getLinkedReadBinding(linkedId)
      expect(binding).toEqual({
        owner: revision,
        linkId: linkedId,
        repositoryId,
        remote: { url: "https://example.test/linked.git", connectionId },
        ref: "main",
        sha: "b".repeat(40),
      })
      if (!binding) throw new Error("Missing fixture binding")
      await withOrgDbContext(org.id, async (db) => {
        if (change === "ref")
          await db
            .update(workspaceLinkedRepositories)
            .set({ desiredRef: "release" })
            .where(eq(workspaceLinkedRepositories.id, linkedId))
        if (change === "owner")
          await db
            .update(workspaces)
            .set({ desiredDefaultBranch: "release" })
            .where(eq(workspaces.id, revision.workspaceId))
        if (change === "connection")
          await db
            .update(repositories)
            .set({ githubConnectionId: null })
            .where(eq(repositories.id, repositoryId))
      })
      expect(
        await persistLinkedDesiredSha({ binding, resolvedTip: "c".repeat(40) }),
      ).toBe(change === "unchanged")
      expect((await getLinkedReadBinding(linkedId))?.sha).toBe(
        change === "unchanged" ? "c".repeat(40) : "b".repeat(40),
      )
    })
  } finally {
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, revision.workspaceId))
      await db.delete(repositories).where(eq(repositories.id, repositoryId))
      await db.delete(connections).where(eq(connections.id, connectionId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
    await closeDb()
  }
})
