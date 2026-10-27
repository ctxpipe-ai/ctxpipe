import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
import { insertLinkedRepositoryRows } from "../test/workspace-links-fixture.js"
import { listLinkedRepositoryPins } from "./workspace-source-state.js"
import { ensureOrgFirstWorkspace } from "./workspaces.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgIds: string[] = []

async function seedOrg(input: {
  name: string
  workspaceUrls: { a: string; b: string }
  repositoryUrls: { a: string; b: string }
}) {
  const orgId = `org_test_dest_${input.name}_${suffix}`
  orgIds.push(orgId)
  const id = (prefix: string, key: string) =>
    `${prefix}_test_dest_${input.name}_${key}_${suffix}`
  await getSystemDb()
    .insert(organizations)
    .values({ id: orgId, slug: orgId, name: "Dest", createdAt: new Date() })
  await withOrgDbContext(orgId, async (db) => {
    await db.insert(workspaces).values(
      (["a", "b"] as const).map((key) => ({
        id: id("ws", key),
        orgId,
        slug: id("ws", key).replaceAll("_", "-"),
        displayName: `Workspace ${key}`,
        workspaceRepositoryUrl: input.workspaceUrls[key],
        desiredDefaultBranch: "main",
      })),
    )
    await db.insert(repositories).values([
      {
        id: id("repo", "a"),
        orgId,
        name: "a",
        gitUrl: input.repositoryUrls.a,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: id("repo", "b"),
        orgId,
        name: "b",
        gitUrl: input.repositoryUrls.b,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        id: id("repo", "api"),
        orgId,
        name: "api",
        gitUrl: "https://github.com/acme/api",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: id("repo", "lib"),
        orgId,
        name: "lib",
        gitUrl: "https://github.com/acme/lib",
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        id: id("repo", "unlinked"),
        orgId,
        name: "unlinked",
        gitUrl: "https://github.com/acme/unlinked",
        createdAt: new Date("2026-01-05T00:00:00.000Z"),
      },
    ])
    await insertLinkedRepositoryRows(db, [
      {
        id: id("wlr", "a_lib"),
        orgId,
        workspaceId: id("ws", "a"),
        gitUrl: "https://github.com/acme/lib",
      },
      {
        id: id("wlr", "b_api"),
        orgId,
        workspaceId: id("ws", "b"),
        gitUrl: "https://github.com/acme/api",
      },
    ])
  })
  return { orgId, workspaceA: id("ws", "a"), workspaceB: id("ws", "b") }
}

function tipCheckBackfill(orgId: string) {
  return withOrgIdContext({ id: orgId, slug: orgId }, () =>
    withOrgDbContext(orgId, () => ensureOrgFirstWorkspace(orgId)),
  )
}

async function links(orgId: string) {
  const rows = (
    await withOrgDbContext(orgId, (db) =>
      listLinkedRepositoryPins(db, { orgId }),
    )
  ).map(({ id, workspaceId, gitUrl }) => ({ id, workspaceId, gitUrl }))
  return rows.sort((x, y) => x.id.localeCompare(y.id))
}

async function firstWorkspace(orgId: string) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ workspaceId: orgFirstWorkspaces.workspaceId })
      .from(orgFirstWorkspaces)
      .where(eq(orgFirstWorkspaces.orgId, orgId)),
  )
  return row?.workspaceId ?? null
}

describe("dest Workspace backfill (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
  })

  afterAll(async () => {
    for (const orgId of orgIds) {
      await withOrgDbContext(orgId, async (db) => {
        await db
          .delete(orgFirstWorkspaces)
          .where(eq(orgFirstWorkspaces.orgId, orgId))
        await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
        await db.delete(repositories).where(eq(repositories.orgId, orgId))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
    }
    await closeDb()
  })

  it("keeps the link of each Workspace across repeated tip checks", async () => {
    const seed = await seedOrg({
      name: "two",
      workspaceUrls: {
        a: "https://github.com/acme/a",
        b: "https://github.com/acme/b",
      },
      repositoryUrls: {
        a: "https://github.com/acme/a.git",
        b: "https://github.com/acme/b.git",
      },
    })
    const before = await links(seed.orgId)
    for (let run = 0; run < 3; run++) {
      await tipCheckBackfill(seed.orgId)
    }
    expect(await links(seed.orgId)).toEqual(before)
    expect(await firstWorkspace(seed.orgId)).toBe(seed.workspaceA)
  })

  it("changes no link and picks the oldest Workspace when no Workspace matches an org repository", async () => {
    const seed = await seedOrg({
      name: "nomatch",
      workspaceUrls: {
        a: "https://github.com/acme/a",
        b: "https://github.com/acme/b",
      },
      repositoryUrls: {
        a: "https://github.com/acme/other-a",
        b: "https://github.com/acme/other-b",
      },
    })
    const before = await links(seed.orgId)
    await tipCheckBackfill(seed.orgId)
    expect(await links(seed.orgId)).toEqual(before)
    expect(await firstWorkspace(seed.orgId)).toBe(seed.workspaceA)
  })

  it("records the next first Workspace after the first one is deleted, without new links", async () => {
    const seed = await seedOrg({
      name: "deleted",
      workspaceUrls: {
        a: "https://github.com/acme/a",
        b: "https://github.com/acme/b",
      },
      repositoryUrls: {
        a: "https://github.com/acme/a.git",
        b: "https://github.com/acme/b.git",
      },
    })
    await tipCheckBackfill(seed.orgId)
    await withOrgDbContext(seed.orgId, async (db) => {
      await db
        .delete(orgFirstWorkspaces)
        .where(eq(orgFirstWorkspaces.orgId, seed.orgId))
      await db.delete(workspaces).where(eq(workspaces.id, seed.workspaceA))
    })
    const before = await links(seed.orgId)
    await tipCheckBackfill(seed.orgId)
    expect(await links(seed.orgId)).toEqual(before)
    expect(await firstWorkspace(seed.orgId)).toBe(seed.workspaceB)
  })
})
