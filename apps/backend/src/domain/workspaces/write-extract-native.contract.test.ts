import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { objects } from "../../db/schema/objects.js"
import {
  persistBoundWriteJob,
  persistMigrationExportNoOp,
  reconcileWorkspaceWriteJob,
} from "../../models/workspace-write-jobs.js"
import {
  applyDestWorkspaceLinkPlan,
  persistOrgFirstWorkspace,
} from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { upsertRetrievalObjectByDeduplicationKey } from "../../retrieval/services/retrievalObjectWrite.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each(["knowledge/services/billing.md", "knowledge/imported/billing.md"])(
  "preserves extraction identity at %s and a same-name collision after migration cutover",
  { timeout: 60_000 },
  async (knowledgePath) => {
    const secondPath = knowledgePath.replace(/\.md$/, "-2.md")
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: knowledgePath,
            body: "---\nimport_key: legacy:billing\ncustom: Finance\n---\n\n# Billing\nOwner notes.\n",
          },
          {
            path: secondPath,
            body: "---\nimport_key: legacy:billing-two\n---\n\n# Billing\nSecond owner notes.\n",
          },
          {
            path: "notion/source.md",
            body: "# Provider mirror remains unchanged\n",
          },
        ],
      },
      async (f) => {
        await withOrgIdContext(f.org, async () => {
          const repo = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
          })
          if (!repo) throw new Error("Fixture repository unavailable")
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: repo.id,
          })
          await applyDestWorkspaceLinkPlan({
            firstWorkspaceId: f.workspaceId,
            firstSourceRepositoryId: repo.id,
            insertLinks: [
              {
                workspaceId: f.workspaceId,
                gitUrl: "https://github.com/linked/api",
              },
            ],
            deleteLinkIds: [],
          })
          await persistBoundWriteJob({
            id: `wjob_${f.id}_cutover`,
            kind: "migration_export",
            revision: { ...f.revision, access: "write-default" },
          })
          await persistMigrationExportNoOp(`wjob_${f.id}_cutover`, f.sha)
          await withOrgDbContext(f.org.id, () =>
            upsertRetrievalObjectByDeduplicationKey(f.org.id, {
              kind: "Service",
              deduplicationKey: "legacy:billing",
              payload: {
                name: "Billing",
                summary: "New extraction describes the ledger.",
              },
            }),
          )
          await withOrgDbContext(f.org.id, () =>
            upsertRetrievalObjectByDeduplicationKey(f.org.id, {
              kind: "Service",
              deduplicationKey: "legacy:billing-two",
              payload: {
                name: "Billing",
                summary: "The second ledger has separate knowledge.",
              },
            }),
          )
        })
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_extract`
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "extract_ingest",
                },
                {
                  error: (error) => {
                    throw error
                  },
                },
              ),
            ),
          ).toEqual({ started: true })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-extract-ingest",
            input: { revision: { sha: f.sha, access: "write-default" } },
          })
          const { workspaceExtractIngest, workspaceExtractIngestInputSchema } =
            await import(
              "../../openworkflow/workflows/workspace-extract-ingest.js"
            )
          runner.implementWorkflow(
            workspaceExtractIngest.spec,
            workspaceExtractIngest.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(jobId),
                ),
              { timeout: 25_000 },
            )
            .toMatchObject({ status: "completed" })
          const content = f.git(
            "--git-dir",
            f.remote,
            "show",
            `main:${knowledgePath}`,
          )
          expect(content).toContain("Owner notes.")
          expect(content).toContain("New extraction describes the ledger.")
          expect(content).toContain("custom: Finance")
          expect(content).not.toContain("import_key")
          expect(
            f.git("--git-dir", f.remote, "diff", "--name-only", f.sha, "main"),
          ).toBe([knowledgePath, secondPath].sort().join("\n"))
          const secondContent = f.git(
            "--git-dir",
            f.remote,
            "show",
            `main:${secondPath}`,
          )
          expect(secondContent).toContain("Second owner notes.")
          expect(secondContent).toContain(
            "The second ledger has separate knowledge.",
          )
          expect(secondContent).not.toContain("import_key")
          expect(secondContent).not.toContain(
            "New extraction describes the ledger.",
          )
          const replay = await runner.runWorkflow(
            workspaceExtractIngest.spec,
            workspaceExtractIngestInputSchema.parse(queued?.input),
          )
          expect(await replay.result({ timeoutMs: 15_000 })).toMatchObject({
            committed: true,
          })
          const unchanged = await runner.runWorkflow(
            workspaceExtractIngest.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `${jobId}_unchanged`,
              revision: {
                ...(await f.resolveRevision()),
                access: "write-default",
              },
            },
          )
          expect(await unchanged.result({ timeoutMs: 15_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          await withOrgDbContext(f.org.id, async (db) => {
            await db
              .delete(objects)
              .where(eq(objects.deduplicationKey, "legacy:billing-two"))
          })
          const omitted = await runner.runWorkflow(
            workspaceExtractIngest.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `${jobId}_omitted`,
              revision: {
                ...(await f.resolveRevision()),
                access: "write-default",
              },
            },
          )
          expect(await omitted.result({ timeoutMs: 15_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          await withOrgDbContext(f.org.id, () =>
            upsertRetrievalObjectByDeduplicationKey(f.org.id, {
              kind: "Service",
              deduplicationKey: "legacy:billing-two",
              payload: {
                name: "Billing",
                summary: "The second ledger has separate knowledge.",
              },
            }),
          )
          const reappeared = await runner.runWorkflow(
            workspaceExtractIngest.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `${jobId}_reappeared`,
              revision: {
                ...(await f.resolveRevision()),
                access: "write-default",
              },
            },
          )
          expect(await reappeared.result({ timeoutMs: 15_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)

it.each(["migration_export", "extract_ingest"] as const)(
  "durably queues an unwritable %s command to its typed workflow",
  { timeout: 30_000 },
  async (kind) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const jobId = `wjob_${f.id}_paused`
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              { orgId: f.org.id, workspaceId: f.workspaceId, jobId, kind },
              {
                error: (error) => {
                  throw error
                },
              },
            ),
          ),
        ).toEqual({ started: true })
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          ),
        ).toMatchObject({ kind, status: "paused", commitSha: null })
        const { BackendPostgres } = await import("openworkflow/postgres")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const owners = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(owners).toHaveLength(1)
          expect(owners[0]).toMatchObject({
            workflowName:
              kind === "migration_export"
                ? "workspace-write-migration-export"
                : "workspace-write-extract-ingest",
            input: { jobId, revision: { sha: f.sha, access: "write-default" } },
          })
        } finally {
          await backend.stop()
        }
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      },
    )
  },
)

it(
  "captures extraction objects and export cutover in one PostgreSQL snapshot",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const { Client } = await import("pg")
      const { loadExtractionProjectionSource } = await import(
        "../../models/workspace-export.js"
      )
      const { persistWriteJobKnowledgePaths } = await import(
        "../../models/workspace-write-jobs.js"
      )
      const blocker = new Client({ connectionString: f.databaseUrl })
      await blocker.connect()
      let pending: ReturnType<typeof loadExtractionProjectionSource> | undefined
      try {
        await blocker.query("BEGIN")
        await blocker.query("LOCK TABLE claims IN ACCESS EXCLUSIVE MODE")
        pending = withOrgIdContext(f.org, () =>
          loadExtractionProjectionSource(f.revision),
        )
        // The source read has consumed objects and is blocked on claims before the export commits.
        await expect
          .poll(
            async () => {
              const result = await blocker.query(
                "select count(*)::int as count from pg_locks where relation='claims'::regclass and mode='AccessShareLock' and not granted",
              )
              return result.rows[0].count
            },
            { timeout: 5_000 },
          )
          .toBeGreaterThan(0)
        await withOrgIdContext(f.org, async () => {
          const id = `wjob_${f.id}_interleaved_export`
          await persistBoundWriteJob({
            id,
            kind: "migration_export",
            revision: { ...f.revision, access: "write-default" },
            workflowRunId: `fixture_${f.id}`,
          })
          await persistWriteJobKnowledgePaths(id, {
            "legacy:billing": "knowledge/imported/billing.md",
          })
          await persistMigrationExportNoOp(id, f.sha)
        })
        await blocker.query("COMMIT")
        expect(await pending).toMatchObject({
          stampImportKey: true,
          knownKnowledgePaths: {},
        })
        // A subsequent snapshot sees both parts of the completed export together.
        expect(
          await withOrgIdContext(f.org, () =>
            loadExtractionProjectionSource(f.revision),
          ),
        ).toMatchObject({
          stampImportKey: false,
          knownKnowledgePaths: {
            "legacy:billing": "knowledge/imported/billing.md",
          },
        })
      } finally {
        await blocker.query("ROLLBACK")
        await blocker.end()
        await pending?.catch(() => undefined)
      }
    })
  },
)

it(
  "reads completed path identity without waiting for historical job storage",
  { timeout: 15_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const { randomUUID } = await import("node:crypto")
      const { Client } = await import("pg")
      const {
        getCompletedKnowledgePaths,
        persistWriteJobKnowledgePaths,
        persistWriteJobStatus,
      } = await import("../../models/workspace-write-jobs.js")
      await withOrgIdContext(f.org, async () => {
        for (const [index, paths] of (
          [
            { "legacy:first": "knowledge/first.md" },
            { "legacy:second": "knowledge/second.md" },
            { "legacy:pending": "knowledge/pending.md" },
          ] as Record<string, string>[]
        ).entries()) {
          const id = `wjob_${f.id}_bounded_${index}`
          await persistBoundWriteJob({
            id,
            kind: "extract_ingest",
            revision: { ...f.revision, access: "write-default" },
            workflowRunId: randomUUID(),
          })
          await persistWriteJobKnowledgePaths(id, paths)
          if (index < 2) await persistWriteJobStatus(id, "completed")
        }
      })
      const blocker = new Client({ connectionString: f.databaseUrl })
      await blocker.connect()
      let pending: Promise<Record<string, string>> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await blocker.query("BEGIN")
        await blocker.query(
          "LOCK TABLE workspace_write_jobs IN ACCESS EXCLUSIVE MODE",
        )
        pending = withOrgIdContext(f.org, () =>
          getCompletedKnowledgePaths(f.revision),
        )
        const result = await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve("historical job storage blocked the read"),
              1_000,
            )
          }),
        ])
        expect(result).toEqual({
          "legacy:first": "knowledge/first.md",
          "legacy:second": "knowledge/second.md",
        })
      } finally {
        if (timer) clearTimeout(timer)
        await blocker.query("ROLLBACK")
        await blocker.end()
        await pending
      }
    })
  },
)

it(
  "backfills completed path maps by native completion order despite an old completion replay",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const { Pool } = await import("pg")
      const { workspaceKnowledgePathState, workspaceWriteJobs } = await import(
        "../../db/schema/workspaces.js"
      )
      const {
        getCompletedKnowledgePaths,
        persistWriteJobKnowledgePaths,
        persistWriteJobStatus,
      } = await import("../../models/workspace-write-jobs.js")
      const { backfillKnowledgePathState } = await import(
        "../../db/backfill-knowledge-path-state.js"
      )
      const command = f.runner.defineWorkflow<
        {
          orgId: string
          workspaceId: string
          jobId: string
          paths: Record<string, string>
        },
        void
      >({ name: "native-path-assignment" }, async ({ input, run }) =>
        withOrgIdContext(f.org, async () => {
          const id = input.jobId
          await persistBoundWriteJob({
            id,
            kind: "extract_ingest",
            revision: { ...f.revision, access: "write-default" },
            workflowRunId: run.id,
          })
          await persistWriteJobKnowledgePaths(id, input.paths)
          await persistWriteJobStatus(id, "completed")
        }),
      )
      await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
      const worker = f.runner.newWorker({ concurrency: 1 })
      const complete = async (
        suffix: string,
        paths: Record<string, string>,
      ) => {
        const handle = await command.run({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_${suffix}`,
          paths,
        })
        await handle.result({ timeoutMs: 5_000 })
      }
      const { ownerUrlForMigrate } = await import(
        "../../db/owner-migrate-url.js"
      )
      const pool = new Pool({
        connectionString: ownerUrlForMigrate(f.databaseUrl),
      })
      try {
        await worker.start()
        await complete("older", { "legacy:first": "knowledge/first.md" })
        await complete("newer", {
          "legacy:first": "knowledge/reassigned.md",
          "legacy:second": "knowledge/second.md",
        })
        // Fixture of the pre-upgrade helpers: replay refreshed a completed row's
        // updatedAt, but its original native execution finished before the newer job.
        await withOrgDbContext(f.org.id, async (db) => {
          await db
            .update(workspaceWriteJobs)
            .set({ updatedAt: new Date(Date.now() + 60_000) })
            .where(eq(workspaceWriteJobs.id, `wjob_${f.id}_older`))
          await db
            .delete(workspaceKnowledgePathState)
            .where(eq(workspaceKnowledgePathState.workspaceId, f.workspaceId))
        })
        await backfillKnowledgePathState(pool)
        expect(
          await withOrgIdContext(f.org, () =>
            getCompletedKnowledgePaths(f.revision),
          ),
        ).toEqual({
          "legacy:first": "knowledge/reassigned.md",
          "legacy:second": "knowledge/second.md",
        })
        await complete("after_upgrade", {
          "legacy:first": "knowledge/new-first.md",
        })
        await backfillKnowledgePathState(pool)
        expect(
          await withOrgIdContext(f.org, () =>
            getCompletedKnowledgePaths(f.revision),
          ),
        ).toEqual({
          "legacy:first": "knowledge/new-first.md",
          "legacy:second": "knowledge/second.md",
        })
        expect(
          await withOrgIdContext({ ...f.org, id: "org_other" }, () =>
            getCompletedKnowledgePaths(f.revision),
          ),
        ).toEqual({})
      } finally {
        await worker.stop()
        await pool.end()
      }
    })
  },
)

it(
  "does not reuse migration cutover after the workspace binding generation changes",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const { eq } = await import("drizzle-orm")
      const { withOrgDbContext } = await import("../../db/client.js")
      const { workspaces } = await import("../../db/schema/workspaces.js")
      const {
        getMigrationExportSha,
        listMigrationExportShas,
        listMigrationExportJobWorkspaceIds,
      } = await import("../../models/workspace-write-jobs.js")
      const { loadExtractionProjectionSource } = await import(
        "../../models/workspace-export.js"
      )
      await withOrgIdContext(f.org, async () => {
        const id = `wjob_${f.id}_previous_binding_export`
        await persistBoundWriteJob({
          id,
          kind: "migration_export",
          revision: { ...f.revision, access: "write-default" },
        })
        await persistMigrationExportNoOp(id, f.sha)
        expect(await getMigrationExportSha(f.workspaceId)).toBe(f.sha)
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: f.revision.generation + 1 })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect(await getMigrationExportSha(f.workspaceId)).toBeNull()
        expect((await listMigrationExportShas()).has(f.workspaceId)).toBe(false)
        expect(
          (await listMigrationExportJobWorkspaceIds()).has(f.workspaceId),
        ).toBe(false)
        expect(
          await loadExtractionProjectionSource({
            ...f.revision,
            generation: f.revision.generation + 1,
          }),
        ).toMatchObject({ stampImportKey: true, knownKnowledgePaths: {} })
      })
    })
  },
)
