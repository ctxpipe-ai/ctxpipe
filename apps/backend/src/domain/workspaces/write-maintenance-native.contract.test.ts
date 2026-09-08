import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
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
            path: "knowledge/block.md",
            body: '---\nimport_key: >-\n  legacy:billing\nname: "Billing: ledger"\n---\n\n# Keep block body\n',
          },
          {
            path: "knowledge/windows.md",
            body: "\uFEFF---\r\nimport_key: |-\r\n  source:line\r\nkind: Service\r\n---\r\n\r\n# Keep Windows body\r\n",
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
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:knowledge/service.md",
            ),
          ).toBe("---\nkind: Service\n---\n\n# Billing\nPreserved body.")
          expect(
            execFileSync(
              "git",
              [
                "--git-dir",
                f.remote,
                "show",
                "refs/heads/main:knowledge/block.md",
              ],
              { encoding: "utf8" },
            ),
          ).toBe('---\nname: "Billing: ledger"\n---\n\n# Keep block body\n')
          expect(
            execFileSync(
              "git",
              [
                "--git-dir",
                f.remote,
                "show",
                "refs/heads/main:knowledge/windows.md",
              ],
              { encoding: "utf8" },
            ),
          ).toBe(
            "\uFEFF---\r\nkind: Service\r\n---\r\n\r\n# Keep Windows body\r\n",
          )

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
            body: '---\n# Preserve this note\nname: "Billing: ledger"\ntags: [money, ledger]\nclaims:\n  - &source_claim\n    to: archive.md # Preserve claim note\n    predicate: DEPENDS_ON\n    generated_by: ctxpipe\n    review: {owner: Billing}\n---\n\nSee [API](./api.md), [same API](api.md), and [archive](./archive.md).\n',
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
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
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
            claims: [
              {
                to: "archive.md",
                predicate: "DEPENDS_ON",
                generated_by: "ctxpipe",
                review: { owner: "Billing" },
              },
              { to: "./api.md" },
            ],
          })
          const { workspaceHydrate } = await import(
            "../../openworkflow/workflows/workspace-hydrate.js"
          )
          // Consume the post-write hydrate through its native worker.
          await worker.stop()
          runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
          worker = runner.newWorker({ concurrency: 1 })
          const hydrated = await runner.runWorkflow(workspaceHydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: await f.resolveRevision(),
          })
          await worker.start()
          await hydrated.result({ timeoutMs: 30_000 })
          const { getWorkspaceProjection } = await import(
            "../../models/workspaces.js"
          )
          const { readWorkspaceGraph } = await import("./graph-projection.js")
          const graph = await withOrgIdContext(f.org, async () => {
            const projection = await getWorkspaceProjection(f.workspaceId)
            if (projection.kind !== "active")
              throw new Error("Expected an active post-write projection")
            return readWorkspaceGraph({
              orgId: f.org.id,
              orgSlug: f.org.slug,
              projection,
            })
          })
          expect(graph.edges).toHaveLength(1)
          expect(graph.edges[0]).toMatchObject({ predicate: "LINKS_TO" })
          expect(markdown).toContain("# Preserve this note")
          expect(markdown).toContain("&source_claim")
          expect(markdown).toContain("# Preserve claim note")
          const noOpId = `${jobId}_again`
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId: noOpId,
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
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(noOpId),
                ),
              { timeout: 15_000 },
            )
            .toMatchObject({ status: "completed", commitSha: null })

          expect(markdown).toContain(
            "See [API](./api.md), [same API](api.md), and [archive](./archive.md).",
          )
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
            body: "---\nclaims:\n  - &observed\n    to: b.md # Preserve observation\n    generated_by: ctxpipe\n    review: {owner: Billing}\n  - to: stable.md\n    valid_from: 2020-05-06T07:08:09.000Z\n    custom: untouched\n---\n\n# A\n",
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
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
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
            {
              to: "b.md",
              generated_by: "ctxpipe",
              review: { owner: "Billing" },
              valid_from: "2024-01-02T03:04:05.000Z",
            },
            {
              to: "stable.md",
              valid_from: "2020-05-06T07:08:09.000Z",
              custom: "untouched",
            },
          ])
          const firstMarkdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "refs/heads/main:knowledge/a.md",
          )
          expect(firstMarkdown).toContain("&observed")
          expect(firstMarkdown).toContain("# Preserve observation")
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

it(
  "maintains the user's folder-map section from actual Git paths and converges",
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
            body: '---\nname: "Docs: beta"\n---\n\n# Working notes\nKeep this introduction.\n\n## Directory traversal\n- Never write [temporary output](tmp/)\n\n### Our layout\n- [Guides](guides/) — keep owner label\n- [Runtime](code-only/) — keep code folder\n- [Gone](removed/) — obsolete\n\n### Style\nKeep this style instruction.\n',
          },
          { path: "guides/intro.md", body: "# Introduction\n" },
          { path: "reference/api.md", body: "# Reference\n" },
          { path: "a#b(c)?d:e/file.md", body: "# Special folder\n" },
          { path: "code-only/main.ts", body: "export const value = 1\n" },
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
        const jobId = `wjob_${f.id}_folders`
        try {
          const command = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            kind: "ops_folder_map" as const,
          }
          const log = {
            error: (error: Error) => {
              throw error
            },
          }
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob({ ...command, jobId }, log),
            ),
          ).toEqual({ started: true })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-ops-folder-map",
          })
          const { workspaceOpsFolderMap } = await import(
            "../../openworkflow/workflows/workspace-ops-folder-map.js"
          )
          runner.implementWorkflow(
            workspaceOpsFolderMap.spec,
            workspaceOpsFolderMap.fn,
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
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "refs/heads/main:AGENTS.md",
          )
          expect(parse(markdown.split("---")[1] ?? "")).toEqual({
            name: "Docs: beta",
          })
          expect(markdown.match(/### Our layout/g)).toHaveLength(1)
          expect(markdown).toContain("- [Guides](guides/) — keep owner label")
          expect(markdown).toContain(
            "- [Runtime](code-only/) — keep code folder",
          )
          expect(markdown).toContain("- [reference/](reference/)")
          expect(markdown).toContain("- [a#b(c)?d:e/](a%23b%28c%29%3Fd%3Ae/)")
          expect(markdown).not.toContain("removed/")
          expect(markdown).toContain("# Working notes\nKeep this introduction.")
          expect(markdown).toContain("### Style\nKeep this style instruction.")
          expect(markdown).toContain(
            "## Directory traversal\n- Never write [temporary output](tmp/)",
          )
          expect(markdown.indexOf("<!-- /ctxpipe:folder-map -->")).toBeLessThan(
            markdown.indexOf("### Style"),
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "diff",
              "--name-only",
              f.sha,
              "refs/heads/main",
            ),
          ).toBe("AGENTS.md")
          const noOpId = `${jobId}_again`
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob({ ...command, jobId: noOpId }, log),
            ),
          ).toEqual({ started: true })
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () =>
                    (await reconcileWorkspaceWriteJob(noOpId))?.status,
                ),
              { timeout: 15_000 },
            )
            .toBe("completed")
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(noOpId),
            ),
          ).toMatchObject({ commitSha: null })
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
