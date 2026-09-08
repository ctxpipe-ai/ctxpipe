import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getMigrationExportSha,
  getWriteJobCommitSha,
  listMigrationExportShas,
  reconcileWorkspaceWriteJob,
} from "../../models/workspace-write-jobs.js"
import { persistOrgFirstWorkspace } from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { upsertRetrievalObjectByDeduplicationKey } from "../../retrieval/services/retrievalObjectWrite.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it(
  "exports legacy knowledge through one typed native commit and replays its durable result",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "AGENTS.md",
            body: "# Workspace instructions\nKeep this text.\n",
          },
        ],
      },
      async (f) => {
        await withOrgIdContext(f.org, async () => {
          const repository = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
          })
          if (!repository) throw new Error("Source repository was not created")
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: repository.id,
          })
          await withOrgDbContext(f.org.id, () =>
            upsertRetrievalObjectByDeduplicationKey(f.org.id, {
              kind: "Service",
              deduplicationKey: "legacy:billing",
              payload: { name: "Billing", summary: "Ledger lives here." },
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
        const jobId = `wjob_${f.id}_export`
        const publicationChecks: unknown[] = []
        f.onWriteCredentialRequest(async () => {
          publicationChecks.push(
            await withOrgIdContext(f.org, async () => ({
              job: await getWriteJobCommitSha(jobId),
              export: await getMigrationExportSha(f.workspaceId),
              listed: [...(await listMigrationExportShas())],
            })),
          )
        })
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "migration_export",
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
            workflowName: "workspace-write-migration-export",
            input: { revision: { sha: f.sha, access: "write-default" } },
          })
          const {
            workspaceMigrationExport,
            workspaceMigrationExportInputSchema,
          } = await import(
            "../../openworkflow/workflows/workspace-migration-export.js"
          )
          runner.implementWorkflow(
            workspaceMigrationExport.spec,
            workspaceMigrationExport.fn,
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
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "refs/heads/main:knowledge/services/billing.md",
          )
          expect(markdown).toContain("# Billing")
          expect(markdown).toContain("Ledger lives here.")
          expect(markdown).toContain("import_key: legacy:billing")
          expect(publicationChecks).toEqual([
            { job: null, export: null, listed: [] },
          ])
          expect(
            f.git("--git-dir", f.remote, "show", "refs/heads/main:AGENTS.md"),
          ).toBe("# Workspace instructions\nKeep this text.")
          const replay = await runner.runWorkflow(
            workspaceMigrationExport.spec,
            workspaceMigrationExportInputSchema.parse(queued?.input),
          )
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          expect(await replay.result({ timeoutMs: 15_000 })).toEqual({
            committed: true,
            commitSha: tip,
          })
          const repeated = await runner.runWorkflow(
            workspaceMigrationExport.spec,
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
          expect(await repeated.result({ timeoutMs: 15_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
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

it(
  "records the resolved tip for an empty migration without claiming a new commit",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { workspaceMigrationExport } = await import(
          "../../openworkflow/workflows/workspace-migration-export.js"
        )
        f.runner.implementWorkflow(
          workspaceMigrationExport.spec,
          workspaceMigrationExport.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        const input = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_empty_export`,
          revision: { ...f.revision, access: "write-default" as const },
        }
        try {
          const handle = await f.runner.runWorkflow(
            workspaceMigrationExport.spec,
            input,
          )
          await worker.start()
          expect(await handle.result({ timeoutMs: 15_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          expect(
            await withOrgIdContext(f.org, () =>
              getMigrationExportSha(f.workspaceId),
            ),
          ).toBe(f.sha)
          expect(
            await withOrgIdContext(f.org, () => listMigrationExportShas()),
          ).toEqual(new Map([[f.workspaceId, f.sha]]))
          const replay = await f.runner.runWorkflow(
            workspaceMigrationExport.spec,
            input,
          )
          expect(await replay.result({ timeoutMs: 10_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
