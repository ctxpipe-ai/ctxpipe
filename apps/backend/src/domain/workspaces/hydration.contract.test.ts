import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  commitHydrateProjection,
  getWorkspaceById,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import { hydrateKnowledgeTree } from "./hydrate.js"

it("hydrates an immutable native git tree into the tenant's PostgreSQL projection", async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for hydration proof")
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-hydration-contract-"))
  const id = `hydrate_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const org = { id: `org_${id}`, slug: id, name: "Hydration contract" }
  const workspaceId = `ws_${id}`
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  initDb(process.env.DATABASE_URL)
  try {
    git("init", "-b", "main")
    writeFileSync(
      join(directory, "architecture.md"),
      "# Payments\nSettles daily.\n",
    )
    git("add", ".")
    git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Immutable fixture",
    )
    const sha = git("rev-parse", "HEAD")
    // A dirty checkout must not change the revision being hydrated.
    writeFileSync(
      join(directory, "architecture.md"),
      "Uncommitted replacement\n",
    )
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgIdContext(org, async () => {
      await withOrgDbContext(org.id, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId: org.id,
          slug: id,
          displayName: org.name,
          workspaceRepositoryUrl: directory,
          desiredSha: sha,
          desiredGeneration: 1,
        }),
      )
      const files = await listMarkdownFilesAtGitSha({ url: directory, sha })
      const parsed = hydrateKnowledgeTree({ workspaceId, files })
      const activated = await commitHydrateProjection({
        orgId: org.id,
        workspaceId,
        jobGeneration: 1,
        jobWorkspaceUrl: directory,
        hydratedSha: sha,
        displayName: null,
        remotes: parsed.linked,
        units: parsed.units,
      })
      expect(activated).toBe(true)
      const projection = await listWorkspaceKnowledgeUnits(workspaceId)
      expect(
        projection.units.map(({ path, body }) => ({ path, body })),
      ).toEqual([
        { path: "architecture.md", body: "# Payments\nSettles daily.\n" },
      ])
      expect((await getWorkspaceById(workspaceId))?.activeProjectionSha).toBe(
        sha,
      )
    })
  } finally {
    try {
      await withOrgDbContext(org.id, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
      )
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, org.id))
    } finally {
      await closeDb()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
