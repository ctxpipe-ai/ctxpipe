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
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  loadWorkspaceChatOrientation,
  WORKSPACE_CHAT_ORIENTATION_MAX_CHARS,
} from "./workspace-chat-orientation.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_orientation_${suffix}`
const workspaceId = `ws_test_orientation_${suffix}`
const activeSha = "a".repeat(40)

describe("loadWorkspaceChatOrientation (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await getSystemDb().insert(organizations).values({
      id: orgId,
      slug: orgId,
      name: "Orientation test",
      createdAt: new Date(),
    })
    // 3,015 files at the active revision: 299 folders of 10 files, 10 files
    // at the root, and 15 in decisions/. One file of an older revision must
    // not count.
    const unit = (path: string, projectionSha: string, i: number) => ({
      servingId: `unit_${suffix}_${i}`,
      orgId,
      workspaceId,
      path,
      body: "# Unit\n",
      projectionSha,
    })
    const units = [
      ...Array.from({ length: 2_990 }, (_, i) =>
        unit(
          `folder-${String(i % 299).padStart(3, "0")}/file-${i}-secret-name.md`,
          activeSha,
          i,
        ),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        unit(`top-${i}.md`, activeSha, 3_000 + i),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        unit(`decisions/adr-${i}.md`, activeSha, 4_000 + i),
      ),
      unit("stale/old.md", "b".repeat(40), 9_999),
    ]
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `orientation-${suffix}`,
        displayName: "Orientation",
        workspaceRepositoryUrl: "https://github.com/example/context.git",
        activeProjectionSha: activeSha,
      })
      for (let i = 0; i < units.length; i += 500)
        await db.insert(workspaceKnowledgeUnits).values(units.slice(i, i + 500))
    })
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("counts files by folder and stays under the cap for a large Workspace", async () => {
    const text = await loadWorkspaceChatOrientation({ orgId, workspaceId })
    expect(text.length).toBeLessThanOrEqual(
      WORKSPACE_CHAT_ORIENTATION_MAX_CHARS,
    )
    expect(text).not.toContain("secret-name")
    expect(text).not.toContain("stale")
    const parsed = JSON.parse(text)
    expect(parsed.knowledge.files).toBe(3_015)
    expect(parsed.knowledge.folders).toBe(301)
    expect(parsed.knowledge.largestFolders.slice(0, 3)).toEqual([
      { path: "decisions/", files: 15 },
      { path: ".", files: 10 },
      { path: "folder-000/", files: 10 },
    ])
    expect(
      parsed.knowledge.largestFolders.length + parsed.knowledge.moreFolders,
    ).toBe(301)
    expect(await loadWorkspaceChatOrientation({ orgId, workspaceId })).toBe(
      text,
    )
  })
})
