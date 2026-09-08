import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getMigrationExportSha,
  getWriteJobCommitSha,
  listMigrationExportShas,
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
            path: "repositories/api.md",
            body: "---\ngit: https://github.com/existing/api.git\ncustom: keep\n---\n",
          },
          {
            path: "knowledge/services/billing.md",
            body: '---\nimport_key: legacy:billing\nname: "Owner: billing"\ncustom: {owner: Finance}\nclaims:\n  - to: api.md\n    predicate: USES\n    confidence: 0.9\n    custom: preserve\n  - to: optional.md\n    predicate: USES\n---\n\n# Billing\nOwner-authored ledger notes.\n',
          },
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
          await applyDestWorkspaceLinkPlan({
            firstWorkspaceId: f.workspaceId,
            firstSourceRepositoryId: repository.id,
            deleteLinkIds: [],
            insertLinks: [
              { workspaceId: f.workspaceId, gitUrl: "not-a-git-url" },
              {
                workspaceId: f.workspaceId,
                gitUrl: "https://github.com/Team-A/API.git",
              },
              {
                workspaceId: f.workspaceId,
                gitUrl: "git@github.com:team-b/api.git",
              },
            ],
          })
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
          expect(markdown).toContain("Owner-authored ledger notes.")
          const { parse } = await import("yaml")
          expect(parse(markdown.split("---")[1] ?? "")).toMatchObject({
            name: "Owner: billing",
            custom: { owner: "Finance" },
            claims: [
              {
                to: "api.md",
                predicate: "USES",
                confidence: 0.9,
                custom: "preserve",
              },
              { to: "optional.md", predicate: "USES" },
            ],
          })
          expect(parse(markdown.split("---")[1] ?? "").claims[1]).toEqual({
            to: "optional.md",
            predicate: "USES",
          })
          expect(markdown).toContain("Ledger lives here.")
          expect(markdown).toContain("import_key: legacy:billing")
          expect(
            f.git("--git-dir", f.remote, "show", "main:repositories/api-2.md"),
          ).toContain("https://github.com/team-a/api")
          expect(
            f.git("--git-dir", f.remote, "show", "main:repositories/api-3.md"),
          ).toContain("https://github.com/team-b/api")
          expect(
            f.git("--git-dir", f.remote, "show", "main:repositories/api.md"),
          ).toContain("custom: keep")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "main",
              "repositories/",
            ),
          ).toBe(
            "repositories/api-2.md\nrepositories/api-3.md\nrepositories/api.md",
          )
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

it(
  "omits credential-bearing legacy repository source URLs from exported knowledge",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "AGENTS.md", body: "# Keep\n" }],
      },
      async (f) => {
        await withOrgIdContext(f.org, async () => {
          const { createRepository } = await import(
            "../../models/repositories.js"
          )
          const source = await createRepository({
            name: "Legacy source",
            gitUrl:
              "https://fixture-user:fixture-password@github.com/source/code.git",
          })
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: source.id,
          })
          await withOrgDbContext(f.org.id, () =>
            upsertRetrievalObjectByDeduplicationKey(f.org.id, {
              kind: "Service",
              deduplicationKey: `svc:${source.id}:src/billing.ts`,
              payload: {
                name: "Billing",
                summary: "Keep the exported knowledge.",
                path: "src/billing.ts",
              },
            }),
          )
        })
        const { workspaceMigrationExport } = await import(
          "../../openworkflow/workflows/workspace-migration-export.js"
        )
        f.runner.implementWorkflow(
          workspaceMigrationExport.spec,
          workspaceMigrationExport.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          const handle = await f.runner.runWorkflow(
            workspaceMigrationExport.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_unsafe_source`,
              revision: { ...f.revision, access: "write-default" },
            },
          )
          await worker.start()
          expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
            committed: true,
          })
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "main:knowledge/services/billing.md",
          )
          expect(markdown).toContain("Keep the exported knowledge.")
          expect(markdown).not.toContain("fixture-password")
          expect(markdown).not.toContain("fixture-user")
          expect(markdown).not.toContain("source:")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
