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
import { workspaces } from "../../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

/*
 * The graph phase of the Workspace pane (CTX-1519). The knowledge plane
 * holds the graph. The phase is ready when the plane has a ready head of the
 * Workspace, and the graph route answers "building" until then.
 */

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_graph_phase_${suffix}`,
  slug: `graph-phase-${suffix}`,
  name: "Graph phase",
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb()
    .insert(organizations)
    .values({ ...org, createdAt: new Date() })
})

afterAll(async () => {
  await withOrgDbContext(org.id, (db) =>
    db.delete(workspaces).where(inArray(workspaces.orgId, [org.id])),
  )
  await getSystemDb()
    .delete(organizations)
    .where(inArray(organizations.id, [org.id]))
  await closeDb()
})

/**
 * A Workspace with a ready projection and index, with a ready head of the
 * knowledge plane when `planeHead` is true.
 */
async function seedWorkspace(
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

async function graphPhase(slug: string) {
  const response = await workspaceHttpApp(org, workspaceRoutes).request(
    `/workspaces/${slug}`,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    hydratePhases: { graph: { kind: string } }
  }
  return body.hydratePhases.graph.kind
}

it("with a ready plane head, the graph phase is ready", async () => {
  expect(await graphPhase(await seedWorkspace("plane", true))).toBe("ready")
})

it("with no plane head, the graph phase is pending, and the graph route answers 202 building", async () => {
  const slug = await seedWorkspace("no-plane", false)
  expect(await graphPhase(slug)).toBe("pending")
  const response = await workspaceHttpApp(org, workspaceRoutes).request(
    `/workspaces/${slug}/graph`,
  )
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ building: true })
})
