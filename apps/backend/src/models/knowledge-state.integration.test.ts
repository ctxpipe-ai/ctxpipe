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
  deleteBranchHead,
  getBranchHead,
  getKnowledgeState,
  listBranchHeads,
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
    const main = { ...workspace, branch: "main" }
    // Before the owning org has a row: no other org can take it.
    await expect(
      beginKnowledgeRun({
        orgId: otherOrgId,
        workspaceId,
        branch: "main",
        isDefault: true,
      }),
    ).rejects.toThrow(`has no Workspace ${workspaceId}`)
    expect(await getBranchHead(main)).toBeNull()
    expect(await getKnowledgeState(workspace)).toBeNull()
    await expect(
      failKnowledgeRun({ ...main, isDefault: true }),
    ).rejects.toThrow("call beginKnowledgeRun first")
    await expect(
      completeKnowledgeRun({
        ...main,
        tip: "sha-x",
        treeVersion: 1,
        mergeBase: null,
        projectionVersion: "1:test-model",
        failedCount: 0,
      }),
    ).rejects.toThrow("call beginKnowledgeRun first")
  })

  it("moves the head of each branch in one update, mirrors the default branch in knowledge_state, and follows the newest default tree", async () => {
    const main = { ...workspace, branch: "main" }
    const feature = { ...workspace, branch: "feature" }
    expect(await readyKnowledgeHeads(orgId, [workspaceId])).toEqual(new Map())

    await beginKnowledgeRun({ ...main, isDefault: true })
    expect(await getBranchHead(main)).toMatchObject({
      lastSha: null,
      treeVersion: 0,
      runStatus: "running",
    })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      runStatus: "running",
    })
    await failKnowledgeRun({ ...main, isDefault: true })
    // A Workspace before its first completed run is not ready.
    expect(await readyKnowledgeHeads(orgId, [workspaceId])).toEqual(new Map())

    await beginKnowledgeRun({ ...main, isDefault: true })
    await completeKnowledgeRun({
      ...main,
      tip: "sha-main",
      treeVersion: 1,
      mergeBase: null,
      projectionVersion: "1:test-model",
      failedCount: 2,
    })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: "sha-main",
      branch: "main",
      treeVersion: 1,
      runStatus: "completed",
      failedCount: 2,
    })
    const mainHead = { sha: "sha-main", branch: "main", treeVersion: 1 }
    expect(await readyKnowledgeHeads(orgId, [workspaceId])).toEqual(
      new Map([[workspaceId, mainHead]]),
    )
    // A branch before its first run has no head.
    expect(await readyKnowledgeHeads(orgId, [workspaceId], "feature")).toEqual(
      new Map(),
    )

    // An overlay: its head has the default branch as its base, and it does
    // not change knowledge_state.
    await beginKnowledgeRun({ ...feature, isDefault: false })
    await completeKnowledgeRun({
      ...feature,
      tip: "sha-feature",
      treeVersion: 1,
      mergeBase: "sha-base",
      projectionVersion: "1:test-model",
      failedCount: 0,
    })
    expect(
      (await readyKnowledgeHeads(orgId, [workspaceId], "feature")).get(
        workspaceId,
      ),
    ).toEqual({
      sha: "sha-feature",
      branch: "feature",
      treeVersion: 1,
      base: mainHead,
    })
    expect(await getKnowledgeState(workspace)).toMatchObject({
      lastSha: "sha-main",
      branch: "main",
    })
    // The default branch by name is the default head.
    expect(
      (await readyKnowledgeHeads(orgId, [workspaceId], "main")).get(
        workspaceId,
      ),
    ).toEqual(mainHead)

    // A failed run keeps the head: a read still sees tree version 1.
    await beginKnowledgeRun({ ...feature, isDefault: false })
    await failKnowledgeRun({ ...feature, isDefault: false })
    expect(
      (await readyKnowledgeHeads(orgId, [workspaceId], "feature")).get(
        workspaceId,
      )?.treeVersion,
    ).toBe(1)

    // A rename: the first completed full tree of `trunk` becomes the head
    // of the default branch.
    const trunk = { ...workspace, branch: "trunk" }
    await beginKnowledgeRun({ ...trunk, isDefault: true })
    expect(
      (await readyKnowledgeHeads(orgId, [workspaceId])).get(workspaceId),
    ).toEqual(mainHead)
    await completeKnowledgeRun({
      ...trunk,
      tip: "sha-main",
      treeVersion: 1,
      mergeBase: null,
      projectionVersion: "1:test-model",
      failedCount: 0,
    })
    expect(
      (await readyKnowledgeHeads(orgId, [workspaceId])).get(workspaceId)
        ?.branch,
    ).toBe("trunk")
    expect(
      (await listBranchHeads(workspace)).map((row) => row.branch).sort(),
    ).toEqual(["feature", "main", "trunk"])

    await deleteBranchHead(feature)
    expect(await getBranchHead(feature)).toBeNull()
    // The head is only for the org of the Workspace.
    expect(await readyKnowledgeHeads(otherOrgId, [workspaceId])).toEqual(
      new Map(),
    )
  })
})
