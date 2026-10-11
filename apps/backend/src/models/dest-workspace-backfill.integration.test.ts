import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import {
  orgFirstWorkspaces,
  workspaceLinkedRepositories,
  workspaces,
} from "../db/schema/workspaces.js"
import { backfillDestWorkspaceAssignment } from "./workspaces.js"

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
    ])
    await db.insert(workspaceLinkedRepositories).values([
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
    withOrgDbContext(orgId, () => backfillDestWorkspaceAssignment(orgId)),
  )
}

async function links(orgId: string) {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        id: workspaceLinkedRepositories.id,
        workspaceId: workspaceLinkedRepositories.workspaceId,
        gitUrl: workspaceLinkedRepositories.gitUrl,
      })
      .from(workspaceLinkedRepositories)
      .where(eq(workspaceLinkedRepositories.orgId, orgId)),
  )
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

  it("deletes no link when no Workspace matches an org repository", async () => {
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
    expect(await firstWorkspace(seed.orgId)).toBeNull()
  })
})
