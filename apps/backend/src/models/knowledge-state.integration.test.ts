import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
  failKnowledgeRun,
  getKnowledgeState,
} from "./knowledge-state.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_kstate_${suffix}`
const otherOrgId = `org_test_kstate_other_${suffix}`
const workspaceId = `ws_test_kstate_${suffix}`
const workspace = { orgId, workspaceId }

describe("knowledge_state (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await getSystemDb()
      .insert(organizations)
      .values(
        [orgId, otherOrgId].map((id) => ({
          id,
          slug: id,
          name: "Knowledge state",
          createdAt: new Date(),
        })),
      )
    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: workspaceId.replaceAll("_", "-"),
        displayName: "Knowledge state",
        workspaceRepositoryUrl: `https://github.com/example/${workspaceId}.git`,
        desiredDefaultBranch: "main",
      }),
    )
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
    )
    for (const id of [orgId, otherOrgId])
      await getSystemDb().delete(organizations).where(eq(organizations.id, id))
    await closeDb()
  })

  it("refuses a run of a Workspace of another org, and an update without a run", async () => {
    // Before the owning org has a row: no other org can take it.
    await expect(
      beginKnowledgeRun({ orgId: otherOrgId, workspaceId, tip: "sha-x", hydratedAt: new Date() }),
    ).rejects.toThrow(`has no Workspace ${workspaceId}`)
    expect(await getKnowledgeState(workspace)).toBeNull()
    expect(
      await getKnowledgeState({ orgId: otherOrgId, workspaceId }),
    ).toBeNull()
    await expect(failKnowledgeRun(workspace)).rejects.toThrow(
      "call beginKnowledgeRun first",
    )
    await expect(
      completeKnowledgeRun({
        ...workspace,
        tip: "sha-x",
        projectionVersion: "1:test-model",
        failedCount: 0,
      }),
    ).rejects.toThrow("call beginKnowledgeRun first")
  })

  it("adds each tip before a run, and moves last_sha and clears the list in one update", async () => {
    expect(await getKnowledgeState(workspace)).toBeNull()

    await beginKnowledgeRun({ ...workspace, tip: "sha-1", hydratedAt: new Date() })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: null,
      attemptShas: ["sha-1"],
      projectionVersion: null,
      runStatus: "running",
      failedCount: 0,
    })

    await failKnowledgeRun(workspace)
    // A retry of the same tip adds nothing; the next tip adds to the list.
    await beginKnowledgeRun({ ...workspace, tip: "sha-1", hydratedAt: new Date() })
    await failKnowledgeRun(workspace)
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: null,
      attemptShas: ["sha-1"],
      runStatus: "failed",
    })
    await beginKnowledgeRun({ ...workspace, tip: "sha-2", hydratedAt: new Date() })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      attemptShas: ["sha-1", "sha-2"],
      runStatus: "running",
    })

    await completeKnowledgeRun({
      ...workspace,
      tip: "sha-2",
      projectionVersion: "1:test-model",
      failedCount: 2,
    })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: "sha-2",
      attemptShas: [],
      projectionVersion: "1:test-model",
      runStatus: "completed",
      failedCount: 2,
    })

    // A failed run after it keeps last_sha and its own tip.
    await beginKnowledgeRun({ ...workspace, tip: "sha-3", hydratedAt: new Date() })
    await failKnowledgeRun(workspace)
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: "sha-2",
      attemptShas: ["sha-3"],
      projectionVersion: "1:test-model",
      runStatus: "failed",
    })
  })
})
