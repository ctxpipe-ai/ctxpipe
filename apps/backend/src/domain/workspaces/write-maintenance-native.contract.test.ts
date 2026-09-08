import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"

it(
  "removes import keys through one typed native maintenance commit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "knowledge/service.md",
            body: "---\nimport_key: legacy:billing\nkind: Service\n---\n\n# Billing\nPreserved body.\n",
          },
          {
            path: "notion/source.md",
            body: "---\nimport_key: external:page\n---\n\nKeep source untouched.\n",
          },
        ],
      },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_cleanup`
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "import_key_cleanup",
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
            workflowName: "workspace-write-import-key-cleanup",
            input: { revision: { sha: f.sha, access: "write-default" } },
          })
          const { workspaceImportKeyCleanup } = await import(
            "../../openworkflow/workflows/workspace-import-key-cleanup.js"
          )
          runner.implementWorkflow(
            workspaceImportKeyCleanup.spec,
            workspaceImportKeyCleanup.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await getWorkspaceWriteJob(jobId))?.status,
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
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:knowledge/service.md",
            ),
          ).toBe("---\nkind: Service\n---\n\n# Billing\nPreserved body.")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:notion/source.md",
            ),
          ).toBe(
            "---\nimport_key: external:page\n---\n\nKeep source untouched.",
          )
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "upgrades Markdown links to claims while preserving other metadata and body",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "knowledge/service.md",
            body: '---\n# Preserve this note\nname: "Billing: ledger"\ntags: [money, ledger]\n---\n\nSee [API](./api.md).\n',
          },
          { path: "knowledge/api.md", body: "# API\nUnchanged endpoint.\n" },
        ],
      },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { parse } = await import("yaml")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_claims`
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "claims_upgrade",
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
            workflowName: "workspace-write-claims-upgrade",
            input: { revision: { sha: f.sha, access: "write-default" } },
          })
          const { workspaceClaimsUpgrade } = await import(
            "../../openworkflow/workflows/workspace-claims-upgrade.js"
          )
          runner.implementWorkflow(
            workspaceClaimsUpgrade.spec,
            workspaceClaimsUpgrade.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await getWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "refs/heads/main:knowledge/service.md",
          )
          expect(parse(markdown.split("---")[1] ?? "")).toEqual({
            name: "Billing: ledger",
            tags: ["money", "ledger"],
            claims: [{ to: "./api.md" }],
          })
          expect(markdown).toContain("# Preserve this note")
          expect(markdown).toMatch(/\n\nSee \[API\]\(\.\/api\.md\)\.$/)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:knowledge/api.md",
            ),
          ).toBe("# API\nUnchanged endpoint.")
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
  "persists each file's introducing timestamp while retaining explicit claim dates",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        initialCommitDate: "2024-01-02T03:04:05Z",
        files: [
          {
            path: "knowledge/a.md",
            body: "---\nclaims:\n  - to: b.md\n  - to: stable.md\n    valid_from: 2020-05-06T07:08:09.000Z\n---\n\n# A\n",
          },
        ],
      },
      async (f) => {
        writeFileSync(
          join(f.directory, "knowledge/b.md"),
          "---\nclaims:\n  - to: a.md\n---\n\n# B\n",
        )
        f.git("add", "knowledge/b.md")
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Later author",
            "-c",
            "user.email=later@example.test",
            "commit",
            "-m",
            "Introduce B later",
          ],
          {
            cwd: f.directory,
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: "2024-02-03T04:05:06Z",
              GIT_COMMITTER_DATE: "2024-02-03T04:05:06Z",
            },
          },
        )
        f.git("push", f.remote, "HEAD:refs/heads/main")
        await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { parse } = await import("yaml")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_dates`
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "valid_from_persist",
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
            workflowName: "workspace-write-valid-from-persist",
          })
          const { workspaceValidFromPersist } = await import(
            "../../openworkflow/workflows/workspace-valid-from-persist.js"
          )
          runner.implementWorkflow(
            workspaceValidFromPersist.spec,
            workspaceValidFromPersist.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await getWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          const first = parse(
            f
              .git(
                "--git-dir",
                f.remote,
                "show",
                "refs/heads/main:knowledge/a.md",
              )
              .split("---")[1] ?? "",
          )
          const second = parse(
            f
              .git(
                "--git-dir",
                f.remote,
                "show",
                "refs/heads/main:knowledge/b.md",
              )
              .split("---")[1] ?? "",
          )
          expect(first.claims).toEqual([
            { to: "b.md", valid_from: "2024-01-02T03:04:05.000Z" },
            { to: "stable.md", valid_from: "2020-05-06T07:08:09.000Z" },
          ])
          expect(second.claims).toEqual([
            { to: "a.md", valid_from: "2024-02-03T04:05:06.000Z" },
          ])
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("2")
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)
