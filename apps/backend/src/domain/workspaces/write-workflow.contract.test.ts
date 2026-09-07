import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { workspaceWriteCommit } from "../../openworkflow/workflows/workspace-write-commit.js"
import { workspaceWriteJobInputSchema } from "./write-job-intent.js"

// Gate 1 executes and records the existing failure; Gate 3 replaces this
// characterization with successful commit/CAS/bare-remote contracts.
it.each(workspaceWriteJobInputSchema.shape.kind.options)(
  "records the existing %s workflow failure in real PostgreSQL",
  { timeout: 20_000 },
  async (kind) => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for workflow proof")
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-write-workflow-"))
    const id = `write_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const orgId = `org_${id}`
    const workspaceId = `ws_${id}`
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    git("init", "-b", "main")
    git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Initial revision",
    )
    const sha = git("rev-parse", "HEAD")
    const remote = join(directory, "remote.git")
    git("clone", "--bare", directory, remote)
    const originalRefs = git(
      "--git-dir",
      remote,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    )
    initDb(databaseUrl)
    const backend = await BackendPostgres.connect(databaseUrl, {
      runMigrations: false,
      namespaceId: id,
    })
    const runner = new OpenWorkflow({ backend })
    // One attempt exposes the current failure without automatic retry delays.
    const spec = {
      ...workspaceWriteCommit.spec,
      retryPolicy: { maximumAttempts: 1 },
    }
    runner.implementWorkflow(spec, workspaceWriteCommit.fn)
    const worker = runner.newWorker({ concurrency: 1 })
    try {
      await getSystemDb().insert(organizations).values({
        id: orgId,
        slug: id,
        name: "Write workflow contract",
        createdAt: new Date(),
      })
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: id,
          displayName: "Write workflow contract",
          workspaceRepositoryUrl: remote,
          desiredSha: sha,
          desiredGeneration: 1,
          writeStatus: "writable",
        }),
      )
      const handle = await runner.runWorkflow(spec, {
        orgId,
        workspaceId,
        kind,
        defaultBranch: "main",
        jobDesiredSha: sha,
        linkAction: "link",
        linkGitUrl: remote,
        conflictParentSha: sha,
        remoteTipSha: sha,
        mergeFiles: [
          { path: "knowledge/contract.md", content: "# Contract\n" },
        ],
      })
      await worker.start()
      await expect(handle.result({ timeoutMs: 10_000 })).rejects.toThrow(
        "requireCurrentOrgId is not defined",
      )
      const persisted = await backend.getWorkflowRun({
        workflowRunId: handle.workflowRun.id,
      })
      expect(persisted?.status).toBe("failed")
      expect(persisted?.attempts).toBe(1)
      expect(persisted?.error?.message).toContain(
        "requireCurrentOrgId is not defined",
      )
      const jobs = await withOrgDbContext(orgId, (db) =>
        db
          .select()
          .from(workspaceWriteJobs)
          .where(eq(workspaceWriteJobs.workspaceId, workspaceId)),
      )
      expect(jobs).toEqual([])
      expect(
        git(
          "--git-dir",
          remote,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ),
      ).toBe(originalRefs)
    } finally {
      await worker.stop()
      await backend.stop()
      try {
        await getSystemDb().execute(
          sql`delete from openworkflow.workflow_runs where namespace_id = ${id}`,
        )
        await withOrgDbContext(orgId, (db) =>
          db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
        )
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, orgId))
      } finally {
        await closeDb()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)
