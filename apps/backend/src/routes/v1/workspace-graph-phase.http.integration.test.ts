import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { knowledgeBranchHeads } from "../../db/schema/knowledge_state.js"
import { orgFeatures } from "../../db/schema/org_features.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

/*
 * The graph phase of the Workspace pane (CTX-1519). With the flag `on`, the
 * graph route reads the knowledge plane. So a FalkorDB graph that stays
 * `pending` (CTX-1007) must not keep the pane at "Building graph" when the
 * plane has a ready head.
 */

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const orgOf = (flag: "on" | "shadow") => ({
  id: `org_test_graph_phase_${flag}_${suffix}`,
  slug: `graph-phase-${flag}-${suffix}`,
  name: `Graph phase ${flag}`,
})
const orgs = { on: orgOf("on"), shadow: orgOf("shadow") }

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  for (const [flag, org] of Object.entries(orgs)) {
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgDbContext(org.id, (db) =>
      db.insert(orgFeatures).values({
        organizationId: org.id,
        feature: "knowledge_plane",
        value: flag,
      }),
    )
  }
})

afterAll(async () => {
  const ids = Object.values(orgs).map((org) => org.id)
  for (const id of ids)
    await withOrgDbContext(id, (db) =>
      db.delete(workspaces).where(inArray(workspaces.orgId, [id])),
    )
  await getSystemDb()
    .delete(organizations)
    .where(inArray(organizations.id, ids))
  await closeDb()
})

/**
 * A Workspace whose FalkorDB graph of the active revision is `pending`,
 * with a ready head of the knowledge plane when `planeHead` is true.
 */
async function seedWorkspace(
  org: { id: string },
  name: string,
  planeHead: boolean,
): Promise<string> {
  const id = `ws_${name}_${suffix}`
  const url = `https://github.com/example/${name}-${suffix}.git`
  const sha = "c".repeat(40)
  const revision: WorkspaceRevision = {
    workspaceId: id,
    generation: 1,
    remote: { url, connectionId: null },
    defaultBranch: "main",
    sha,
    access: "read",
  }
  await withOrgDbContext(org.id, async (db) => {
    await db.insert(workspaces).values({
      id,
      orgId: org.id,
      slug: name,
      displayName: name,
      workspaceRepositoryUrl: url,
      formatVersion: 3,
      desiredSha: sha,
      desiredDefaultBranch: "main",
      hydrateStatus: "ready",
      // A writable Workspace: the route queues no write probe.
      writeStatus: "writable",
      activeRevision: revision,
      activeProjectionUrl: url,
      activeProjectionSha: sha,
      indexedSha: sha,
      hydratePhases: {
        url,
        sha,
        revision,
        embeddings: true,
        graph: { revision, result: { kind: "pending" } },
        index: { revision, result: { kind: "ready" } },
      },
    })
    if (planeHead)
      await db.insert(knowledgeBranchHeads).values({
        workspaceId: id,
        organizationId: org.id,
        branch: "main",
        lastSha: sha,
        treeVersion: 1,
        runStatus: "completed",
        defaultAt: new Date(),
      })
  })
  return name
}

async function graphPhase(
  org: { id: string; slug: string; name: string },
  slug: string,
) {
  const response = await workspaceHttpApp(org, workspaceRoutes).request(
    `/workspaces/${slug}`,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    hydratePhases: { graph: { kind: string } }
  }
  return body.hydratePhases.graph.kind
}

it("with the flag `on` and a ready plane head, the graph is ready while the FalkorDB graph is pending", async () => {
  expect(
    await graphPhase(orgs.on, await seedWorkspace(orgs.on, "plane", true)),
  ).toBe("ready")
})

it("with the flag `on` and no plane head, the pane shows the FalkorDB phase", async () => {
  expect(
    await graphPhase(orgs.on, await seedWorkspace(orgs.on, "no-plane", false)),
  ).toBe("pending")
})

it("with the flag `shadow`, the pane shows the FalkorDB phase, also with a plane head", async () => {
  expect(
    await graphPhase(
      orgs.shadow,
      await seedWorkspace(orgs.shadow, "shadow", true),
    ),
  ).toBe("pending")
})
