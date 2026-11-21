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
  readyKnowledgeHeads,
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
      beginKnowledgeRun({ orgId: otherOrgId, workspaceId }),
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
        branch: "main",
        treeVersion: 1,
        projectionVersion: "1:test-model",
        failedCount: 0,
      }),
    ).rejects.toThrow("call beginKnowledgeRun first")
  })

  it("marks a run as running, and moves the head (last_sha, branch and tree version) in one update", async () => {
    expect(await getKnowledgeState(workspace)).toBeNull()
    expect(await readyKnowledgeHeads(orgId, [workspaceId])).toEqual(new Map())

    await beginKnowledgeRun(workspace)
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: null,
      branch: null,
      treeVersion: null,
      projectionVersion: null,
      runStatus: "running",
      failedCount: 0,
    })
    await failKnowledgeRun(workspace)
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: null,
      runStatus: "failed",
    })
    // A Workspace before its first completed run is not ready.
    expect(await readyKnowledgeHeads(orgId, [workspaceId])).toEqual(new Map())

    await beginKnowledgeRun(workspace)
    await completeKnowledgeRun({
      ...workspace,
      tip: "sha-2",
      branch: "main",
      treeVersion: 1,
      projectionVersion: "1:test-model",
      failedCount: 2,
    })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: "sha-2",
      branch: "main",
      treeVersion: 1,
      projectionVersion: "1:test-model",
      runStatus: "completed",
      failedCount: 2,
    })
    expect(await readyKnowledgeHeads(orgId, [workspaceId])).toEqual(
      new Map([
        [workspaceId, { sha: "sha-2", branch: "main", treeVersion: 1 }],
      ]),
    )

    // A failed run after it keeps the head: a read still sees tree version 1.
    await beginKnowledgeRun(workspace)
    await failKnowledgeRun(workspace)
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: "sha-2",
      treeVersion: 1,
      runStatus: "failed",
    })
    expect(
      (await readyKnowledgeHeads(orgId, [workspaceId])).get(workspaceId),
    ).toEqual({ sha: "sha-2", branch: "main", treeVersion: 1 })
    // The head is only for the org of the Workspace.
    expect(await readyKnowledgeHeads(otherOrgId, [workspaceId])).toEqual(
      new Map(),
    )
  })
})
