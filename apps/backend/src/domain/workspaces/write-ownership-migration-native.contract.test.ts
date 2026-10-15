import { execFileSync } from "node:child_process"
import { expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { fileOwnership } from "../ingestion/patch-validator.js"

const humanSection =
  "<!-- ctxpipe:human -->\nA note that a human wrote.\n<!-- /ctxpipe:human -->\n"

const files = [
  {
    // An old extracted file from before the migration export.
    path: "knowledge/services/billing.md",
    body: `---\nimport_key: repo_1:service:billing\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing.git#src/index.ts\n---\n\n# Billing\n\nExtracted text.\n\n${humanSection}`,
  },
  {
    // An old extracted file after the import-key cleanup.
    path: "knowledge/libraries/zod.md",
    body: "---\nkind: Library\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing.git#package.json\n---\n\n# Zod\n",
  },
  {
    // A human took this file over: they removed `generated_by`.
    path: "knowledge/services/ledger.md",
    body: "---\nkind: Service\nsource: https://github.com/acme/billing.git#ledger.ts\n---\n\n# Ledger\n\nA human rewrote this file.\n",
  },
  {
    path: "knowledge/notes.md",
    body: "# Notes\n\nA human file with no front matter.\n",
  },
]

it(
  "moves only the old extracted files to ingestion v2 ownership, in one commit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files,
      },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_ownership`
        const show = (path: string) =>
          execFileSync(
            "git",
            ["--git-dir", f.remote, "show", `refs/heads/main:${path}`],
            { encoding: "utf8" },
          )
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "ownership_migration",
                },
                {
                  error: (error) => {
                    throw error
                  },
                },
              ),
            ),
          ).toEqual({ started: true })
          const { workspaceOwnershipMigration } = await import(
            "../../openworkflow/workflows/workspace-ownership-migration.js"
          )
          runner.implementWorkflow(
            workspaceOwnershipMigration.spec,
            workspaceOwnershipMigration.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")

          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
          expect(
            f
              .git(
                "--git-dir",
                f.remote,
                "diff",
                "--name-only",
                f.sha,
                "refs/heads/main",
              )
              .split("\n")
              .sort(),
          ).toEqual([
            "knowledge/libraries/zod.md",
            "knowledge/services/billing.md",
          ])

          const billing = show("knowledge/services/billing.md")
          expect(parse(billing.split("---")[1] ?? "")).toEqual({
            kind: "Service",
            name: "Billing",
            generated_by: "ctxpipe-extract",
            sources: ["https://github.com/acme/billing"],
          })
          expect(
            billing.endsWith(
              `---\n\n# Billing\n\nExtracted text.\n\n${humanSection}`,
            ),
          ).toBe(true)
          expect(
            fileOwnership(billing, "https://github.com/acme/billing"),
          ).toBe("sole")
          expect(
            fileOwnership(
              show("knowledge/libraries/zod.md"),
              "https://github.com/acme/billing",
            ),
          ).toBe("sole")
          for (const file of files.slice(2))
            expect(show(file.path)).toBe(file.body)
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "makes no commit when no old extracted file is left",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: files.slice(2),
      },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_ownership_noop`
        try {
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "ownership_migration",
              },
              {
                error: (error) => {
                  throw error
                },
              },
            ),
          )
          const { workspaceOwnershipMigration } = await import(
            "../../openworkflow/workflows/workspace-ownership-migration.js"
          )
          runner.implementWorkflow(
            workspaceOwnershipMigration.spec,
            workspaceOwnershipMigration.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("0")
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)
