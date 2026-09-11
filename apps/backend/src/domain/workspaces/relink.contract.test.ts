import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withUserIdContext } from "../../auth/context.js"
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
  createWorkspace,
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
        .values({
          id: connectionId,
          orgId: org.id,
          type: "github" as const,
          config: {},
        })
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

it.each(["existing URL", "concurrent unique-index loser"])(
  "%s creates a new revision when duplicate create selects another connection",
  { timeout: 20_000 },
  async (scenario) => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required")
    initDb(process.env.DATABASE_URL)
    const org = {
      id: generateObjectId("org"),
      slug: generateObjectId("slug"),
      name: "Duplicate create",
    }
    const oldConnection = generateObjectId("con")
    const newConnection = generateObjectId("con")
    const revision: WorkspaceRevision = {
      workspaceId: generateObjectId("ws"),
      generation: 3,
      remote: {
        url: "https://example.test/duplicate",
        connectionId: oldConnection,
      },
      sha: "a".repeat(40),
      defaultBranch: "main",
      access: "read",
    }
    const row = {
      id: revision.workspaceId,
      orgId: org.id,
      slug: "duplicate",
      displayName: "Duplicate",
      workspaceRepositoryUrl: revision.remote.url,
      githubConnectionId: oldConnection,
      desiredGeneration: 3,
      desiredSha: revision.sha,
      desiredDefaultBranch: "main",
      activeRevision: revision,
      activeProjectionSha: revision.sha,
      activeProjectionUrl: revision.remote.url,
      hydrateStatus: "ready",
    }
    let release = () => {}
    let inserting: Promise<void> | undefined
    let creating: ReturnType<typeof createWorkspace> | undefined
    try {
      await getSystemDb()
        .insert(organizations)
        .values({ ...org, createdAt: new Date() })
      await withOrgDbContext(org.id, (db) =>
        db.insert(connections).values(
          [oldConnection, newConnection].map((id) => ({
            id,
            orgId: org.id,
            type: "github" as const,
            config: {},
          })),
        ),
      )
      await withOrgIdContext(org, () =>
        withUserIdContext("duplicate-create-proof", async () => {
          if (scenario === "existing URL") {
            await withOrgDbContext(org.id, (db) =>
              db.insert(workspaces).values(row),
            )
          } else {
            const held = new Promise<void>((resolve) => {
              release = resolve
            })
            let signal: (pid: number) => void = () => {}
            const started = new Promise<number>((resolve) => {
              signal = resolve
            })
            inserting = withOrgDbContext(org.id, async (db) => {
              await db.insert(workspaces).values(row)
              const result = await db.execute(
                sql`select pg_backend_pid() as pid`,
              )
              signal(Number(result.rows[0]?.pid))
              await held
            })
            const blocker = await started
            creating = createWorkspace({
              gitUrl: revision.remote.url,
              githubConnectionId: newConnection,
              write: { writeStatus: "writable", readOnlyReason: null },
            })
            const deadline = Date.now() + 10_000
            let blocked = false
            while (Date.now() < deadline) {
              const waiting = await getSystemDb().execute(sql`
              select pid from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))
            `)
              if (waiting.rows.length > 0) {
                blocked = true
                break
              }
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
            expect(blocked).toBe(true)
            release()
            await inserting
          }
          const updated = await (creating ??
            createWorkspace({
              gitUrl: revision.remote.url,
              githubConnectionId: newConnection,
              write: { writeStatus: "writable", readOnlyReason: null },
            }))
          expect(updated).toMatchObject({
            id: revision.workspaceId,
            desiredGeneration: 4,
            desiredSha: null,
            desiredDefaultBranch: null,
            githubConnectionId: newConnection,
            hydrateStatus: "pending",
          })
          expect(
            await getWorkspaceProjection(revision.workspaceId),
          ).toMatchObject({
            kind: "building",
            previous: { kind: "active", revision },
          })
        }),
      )
    } finally {
      release()
      await Promise.allSettled([inserting, creating])
      await withOrgDbContext(org.id, async (db) => {
        await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
        await db.delete(connections).where(eq(connections.orgId, org.id))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, org.id))
      await closeDb()
    }
  },
)
