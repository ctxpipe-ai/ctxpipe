import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "./client.js"
import { organizations } from "./schema/auth.js"
import { workspaces } from "./schema/workspaces.js"

const runId = `rls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const orgA = {
  id: `${runId}_a`,
  slug: `${runId}-a`,
  name: "RLS org A",
}
const orgB = {
  id: `${runId}_b`,
  slug: `${runId}-b`,
  name: "RLS org B",
}

function workspaceValues(
  orgId: string,
  suffix: string,
): typeof workspaces.$inferInsert {
  return {
    id: `ws_${runId}_${suffix}`,
    orgId,
    slug: `ws-${suffix}`,
    displayName: `Workspace ${suffix}`,
    workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${runId}-${suffix}`,
  }
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "DATABASE_URL is required; run this file as ctxpipe_app after owner migrate",
    )
  }
  initDb(url)
  const now = new Date()
  await getSystemDb()
    .insert(organizations)
    .values([
      { id: orgA.id, name: orgA.name, slug: orgA.slug, createdAt: now },
      { id: orgB.id, name: orgB.name, slug: orgB.slug, createdAt: now },
    ])
})

afterAll(async () => {
  try {
    await withOrgDbContext(orgA.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, orgA.id))
    })
    await withOrgDbContext(orgB.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, orgB.id))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, orgA.id))
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, orgB.id))
  } finally {
    await closeDb()
  }
})

describe("RLS isolation", () => {
  it("hides workspace rows without app.organization_id", async () => {
    const ws = workspaceValues(orgA.id, "noguc")
    await withOrgDbContext(orgA.id, async (db) => {
      await db.insert(workspaces).values(ws)
    })

    const leaked = await getSystemDb()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id))
    expect(leaked).toEqual([])

    const updated = await getSystemDb()
      .update(workspaces)
      .set({ displayName: "no-guc" })
      .where(eq(workspaces.id, ws.id))
    expect(updated.rowCount).toBe(0)

    await expect(
      getSystemDb().insert(workspaces).values(workspaceValues(orgA.id, "fail")),
    ).rejects.toSatisfy((error: unknown) => {
      const parts: string[] = []
      let current: unknown = error
      for (let i = 0; i < 6 && current; i++) {
        if (current instanceof Error) {
          parts.push(current.message)
          if ("code" in current) parts.push(String(current.code))
          current = current.cause
          continue
        }
        parts.push(String(current))
        break
      }
      return /row-level security|42501|violates.*policy/i.test(parts.join("\n"))
    })
  })

  it("hides the other org workspace and UPDATE/DELETE 0", async () => {
    const wsA = workspaceValues(orgA.id, "a")
    const wsB = workspaceValues(orgB.id, "b")
    await withOrgDbContext(orgA.id, async (db) => {
      await db.insert(workspaces).values(wsA)
    })
    await withOrgDbContext(orgB.id, async (db) => {
      await db.insert(workspaces).values(wsB)
    })

    const seenByA = await withOrgDbContext(orgA.id, async (db) =>
      db.select({ id: workspaces.id }).from(workspaces),
    )
    const seenByB = await withOrgDbContext(orgB.id, async (db) =>
      db.select({ id: workspaces.id }).from(workspaces),
    )
    expect(seenByA.map((row) => row.id)).toContain(wsA.id)
    expect(seenByA.map((row) => row.id)).not.toContain(wsB.id)
    expect(seenByB.map((row) => row.id)).toContain(wsB.id)
    expect(seenByB.map((row) => row.id)).not.toContain(wsA.id)

    const updated = await withOrgDbContext(orgA.id, async (db) =>
      db
        .update(workspaces)
        .set({ displayName: "stolen" })
        .where(eq(workspaces.id, wsB.id)),
    )
    expect(updated.rowCount).toBe(0)

    const removed = await withOrgDbContext(orgA.id, async (db) =>
      db.delete(workspaces).where(eq(workspaces.id, wsB.id)),
    )
    expect(removed.rowCount).toBe(0)

    const stillB = await withOrgDbContext(orgB.id, async (db) =>
      db
        .select({ displayName: workspaces.displayName })
        .from(workspaces)
        .where(eq(workspaces.id, wsB.id)),
    )
    expect(stillB).toEqual([{ displayName: wsB.displayName }])
  })
})
