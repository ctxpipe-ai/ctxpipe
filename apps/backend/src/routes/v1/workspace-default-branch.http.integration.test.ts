import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { orgFeatures } from "../../db/schema/org_features.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { setOrgFeature } from "../../models/org-features.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_default_branch_${suffix}`,
  slug: `default-branch-${suffix}`,
  name: "Default branch",
}

async function seedWorkspace(name: string, defaultBranch: string | null) {
  await withOrgDbContext(org.id, (db) =>
    db.insert(workspaces).values({
      id: `ws_${name}_${suffix}`,
      orgId: org.id,
      slug: name,
      displayName: name,
      workspaceRepositoryUrl: `https://github.com/example/${name}-${suffix}.git`,
      formatVersion: 3,
      desiredSha: defaultBranch ? "d".repeat(40) : null,
      desiredDefaultBranch: defaultBranch,
      hydrateStatus: defaultBranch ? "ready" : "pending",
    }),
  )
}

// The chat composer shows the base branch of a new conversation before the
// branch list loads, so the Workspace read carries the default branch.
describe("Default branch in the Workspace list (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    // setOrgFeature needs the org row.
    await getSystemDb().insert(organizations).values({
      id: org.id,
      slug: org.slug,
      name: org.name,
      createdAt: new Date(),
    })
  })

  afterAll(async () => {
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
      await db.delete(orgFeatures).where(eq(orgFeatures.organizationId, org.id))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
    await closeDb()
  })

  it("names the default branch of each Workspace, and null before the first tip read", async () => {
    await seedWorkspace("trunk-based", "trunk")
    await seedWorkspace("new", null)

    const response = await workspaceHttpApp(org, workspaceRoutes).request(
      "/workspaces",
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      items: { slug: string; defaultBranch: string | null }[]
    }
    expect(
      Object.fromEntries(
        body.items.map((item) => [item.slug, item.defaultBranch]),
      ),
    ).toEqual({ "trunk-based": "trunk", new: null })
  })

  // The base branch picker of the composer shows only when the org's
  // knowledge_plane flag is not off.
  it("carries the knowledge_plane flag of the org: off by default, then the value that an operator set", async () => {
    const app = workspaceHttpApp(org, workspaceRoutes)
    const flag = async () =>
      (
        (await (await app.request("/workspaces")).json()) as {
          knowledgePlane: string
        }
      ).knowledgePlane

    expect(await flag()).toBe("off")
    await setOrgFeature(org.id, "knowledge_plane", "shadow")
    expect(await flag()).toBe("shadow")
  })
})
