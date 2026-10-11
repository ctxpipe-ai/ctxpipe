import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { PlannedSourceRow } from "../domain/workspace-sources/projection-plan.js"
import {
  listConnectionSourceRows,
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "./workspace-sources.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_wsrc_${suffix}`
const otherOrgId = `org_test_wsrc_other_${suffix}`
const workspaceId = `ws_test_wsrc_${suffix}`
const connectionId = `con_test_wsrc_${suffix}`

function row(overrides: Partial<PlannedSourceRow> = {}): PlannedSourceRow {
  return {
    sourceKey: "eng-issues",
    provider: "linear",
    connectionId,
    scope: { teams: ["ENG"] },
    status: "ok",
    statusDetail: null,
    ...overrides,
  }
}

describe("workspace_sources (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await getSystemDb()
      .insert(organizations)
      .values([
        { id: orgId, slug: orgId, name: "Sources", createdAt: new Date() },
        {
          id: otherOrgId,
          slug: otherOrgId,
          name: "Other",
          createdAt: new Date(),
        },
      ])
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: workspaceId.replaceAll("_", "-"),
        displayName: "Sources Workspace",
        workspaceRepositoryUrl: `https://github.com/acme/${workspaceId}.git`,
        desiredDefaultBranch: "main",
      })
      await db
        .insert(connections)
        .values({ id: connectionId, orgId, type: "linear", config: {} })
    })
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      await db.delete(connections).where(eq(connections.id, connectionId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, otherOrgId))
    await closeDb()
  })

  it("adds, keeps, changes, and removes rows to match the plan, idempotently", async () => {
    const first = await replaceWorkspaceSourceRows({
      orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [row(), row({ sourceKey: "eng-docs", scope: { pages: ["p1"] } })],
    })
    expect(first.added.map((r) => r.sourceKey).sort()).toEqual([
      "eng-docs",
      "eng-issues",
    ])

    const again = await replaceWorkspaceSourceRows({
      orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [row(), row({ sourceKey: "eng-docs", scope: { pages: ["p1"] } })],
    })
    expect(again).toEqual({ added: [], changed: [], removed: [] })

    const next = await replaceWorkspaceSourceRows({
      orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows: [row({ scope: { teams: ["ENG", "OPS"] } })],
    })
    expect(next.removed.map((r) => r.sourceKey)).toEqual(["eng-docs"])
    expect(next.changed).toHaveLength(1)
    expect(next.changed[0]?.before.scope).toEqual({ teams: ["ENG"] })

    const rows = await listWorkspaceSourceRows({ orgId, workspaceId })
    expect(rows).toMatchObject([
      {
        sourceKey: "eng-issues",
        revision: "b".repeat(40),
        scope: { teams: ["ENG", "OPS"] },
      },
    ])
    const used = await listConnectionSourceRows({ orgId, connectionId })
    expect(used).toMatchObject([
      {
        workspaceName: "Sources Workspace",
        source: { sourceKey: "eng-issues" },
      },
    ])
  })

  it("isolates rows by organization (RLS)", async () => {
    expect(
      await listWorkspaceSourceRows({ orgId: otherOrgId, workspaceId }),
    ).toEqual([])
    await expect(
      withOrgDbContext(otherOrgId, (db) =>
        db.insert(workspaceSources).values({
          id: `wsrc_cross_${suffix}`,
          orgId,
          workspaceId,
          sourceKey: "cross-org",
          status: "ok",
          revision: "c".repeat(40),
        }),
      ),
    ).rejects.toThrow()
  })
})
