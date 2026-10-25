import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { CODE_FORMAT } from "../../domain/workspaces/workspace-format.js"
import { insertWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { orgPendingUpgradeRoutes } from "./workspace-upgrades-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_pending_upgrades_${suffix}`,
  slug: `pending-upgrades-${suffix}`,
  name: "Pending upgrades",
}
const rows = [
  // Below the newest format, no upgrade row yet.
  { slug: "a-no-row", formatVersion: 0 },
  // Below the newest format, with a pending upgrade row.
  { slug: "b-with-row", formatVersion: 1 },
  // At the newest format, nothing pending.
  { slug: "c-current", formatVersion: CODE_FORMAT },
  // Not read yet, and a format file that is not valid: an upgrade does not fix them.
  { slug: "d-unread", formatVersion: null },
  { slug: "e-invalid", formatVersion: -1 },
  // At the newest format, with a pending re-ingestion row.
  { slug: "f-reingest", formatVersion: CODE_FORMAT },
] as const

describe("Pending upgrades read (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    const ids = new Map<string, string>()
    await withOrgDbContext(org.id, async (db) => {
      for (const row of rows) {
        const id = `ws_pending_${row.slug}_${suffix}`
        ids.set(row.slug, id)
        await db.insert(workspaces).values({
          id,
          orgId: org.id,
          slug: row.slug,
          displayName: row.slug,
          workspaceRepositoryUrl: `https://github.com/example/${row.slug}-${suffix}.git`,
          formatVersion: row.formatVersion,
        })
      }
    })
    await withOrgIdContext(org, async () => {
      await insertWorkspaceUpgradeRow({
        workspaceId: ids.get("b-with-row") ?? "",
        generation: 1,
        status: "awaiting_operator",
        upgrade: { key: "format-3", fromFormat: 1, targetFormat: 3 },
      })
      await insertWorkspaceUpgradeRow({
        workspaceId: ids.get("f-reingest") ?? "",
        generation: 1,
        status: "awaiting_operator",
        upgrade: { key: "reingest-3", fromFormat: 3, targetFormat: 3 },
      })
    })
  })

  afterAll(async () => {
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
    )
    await closeDb()
  })

  it("lists each Workspace below the newest format, also one with no upgrade row, with its format", async () => {
    const response = await workspaceHttpApp(
      org,
      orgPendingUpgradeRoutes,
    ).request("/workspaces/pending")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      workspaces: Array<{
        workspaceSlug: string
        formatVersion: number | null
        codeFormat: number
        items: Array<{ key: string }>
      }>
    }
    expect(
      body.workspaces.map(({ workspaceSlug, formatVersion, codeFormat }) => ({
        workspaceSlug,
        formatVersion,
        codeFormat,
      })),
    ).toEqual([
      { workspaceSlug: "a-no-row", formatVersion: 0, codeFormat: CODE_FORMAT },
      {
        workspaceSlug: "b-with-row",
        formatVersion: 1,
        codeFormat: CODE_FORMAT,
      },
      {
        workspaceSlug: "f-reingest",
        formatVersion: CODE_FORMAT,
        codeFormat: CODE_FORMAT,
      },
    ])
    expect(
      body.workspaces.map((entry) => entry.items.map((i) => i.key)),
    ).toEqual([[], ["format-3"], ["reingest-3"]])
  })
})
