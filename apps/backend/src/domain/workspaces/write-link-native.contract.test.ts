import { expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it(
  "links and unlinks one canonical remote without overwriting a same-name declaration",
  { timeout: 60_000 },
  async () => {
    const original =
      '---\ngit: https://github.com/old/other.git\nbranch: stable\ncustom: "Owner: old"\n---\n\nKeep this repository note.\n'
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "repositories/other.md", body: original }],
      },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          kind: "link_unlink" as const,
          linkGitUrl: "https://github.com/next/other.git",
        }
        const log = {
          error: (error: Error) => {
            throw error
          },
        }
        const jobId = `wjob_${f.id}_link`
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob({ ...command, jobId, linkAction: "link" }, log),
            ),
          ).toEqual({ started: true })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-link-unlink",
            input: { linkAction: "link", linkGitUrl: command.linkGitUrl },
          })
          const { workspaceLinkUnlink } = await import(
            "../../openworkflow/workflows/workspace-link-unlink.js"
          )
          runner.implementWorkflow(
            workspaceLinkUnlink.spec,
            workspaceLinkUnlink.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(jobId),
                ),
              { timeout: 30_000 },
            )
            .toMatchObject({ status: "completed" })
          const files = f
            .git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "refs/heads/main",
            )
            .split("\n")
          expect(files).toHaveLength(2)
          const added = files.find((path) => path !== "repositories/other.md")
          expect(added).toMatch(/^repositories\/[^/]+\.md$/)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:repositories/other.md",
            ),
          ).toBe(original.trim())
          expect(
            parse(
              f
                .git("--git-dir", f.remote, "show", `refs/heads/main:${added}`)
                .split("---")[1] ?? "",
            ),
          ).toEqual({ git: "https://github.com/next/other.git" })
          const noOpId = `${jobId}_again`
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                { ...command, jobId: noOpId, linkAction: "link" },
                log,
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
          const unlinkId = `${jobId}_unlink`
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  ...command,
                  jobId: unlinkId,
                  linkAction: "unlink",
                  linkGitUrl: "https://github.com/next/other",
                },
                log,
              ),
            ),
          ).toEqual({ started: true })
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(unlinkId),
                ),
              { timeout: 15_000 },
            )
            .toMatchObject({ status: "completed" })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "refs/heads/main",
            ),
          ).toBe("repositories/other.md")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:repositories/other.md",
            ),
          ).toBe(original.trim())
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
