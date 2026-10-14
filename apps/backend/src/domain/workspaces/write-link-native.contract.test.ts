import { expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it(
  "links and unlinks one canonical remote in the GitHub source of sources.yaml",
  { timeout: 60_000 },
  async () => {
    const legacy =
      "---\ngit: https://github.com/old/other.git\nbranch: stable\n---\n\nKeep this repository note.\n"
    const sources =
      "# Owned by the team\nversion: 1\nsources:\n  - id: issues\n    provider: linear\n    connection: con_linear_fixture\n    teams: [ENG]\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "repositories/other.md", body: legacy },
          { path: ".ctxpipe/sources.yaml", body: sources },
        ],
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
        const show = (path: string) =>
          f.git("--git-dir", f.remote, "show", `refs/heads/main:${path}`)
        const tree = () =>
          f
            .git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "refs/heads/main",
            )
            .split("\n")
            .sort()
        const run = async (
          jobId: string,
          linkAction: "link" | "unlink",
          linkGitUrl = command.linkGitUrl,
        ) => {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                { ...command, jobId, linkAction, linkGitUrl },
                log,
              ),
            ),
          ).toEqual({ started: true })
          await expect
            .poll(
              async () =>
                (
                  await withOrgIdContext(f.org, () =>
                    reconcileWorkspaceWriteJob(jobId),
                  )
                )?.status,
              { timeout: 30_000 },
            )
            .toMatch(/^(completed|failed)$/)
          return withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          )
        }
        const jobId = `wjob_${f.id}_link`
        try {
          const { workspaceLinkUnlink } = await import(
            "../../openworkflow/workflows/workspace-link-unlink.js"
          )
          runner.implementWorkflow(
            workspaceLinkUnlink.spec,
            workspaceLinkUnlink.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()

          expect(await run(jobId, "link")).toMatchObject({
            status: "completed",
          })
          // Link edits only sources.yaml; it keeps the comment, the other
          // entry, and the old repository file.
          expect(tree()).toEqual([
            ".ctxpipe/sources.yaml",
            "repositories/other.md",
          ])
          expect(show("repositories/other.md")).toBe(legacy.trim())
          const linked = show(".ctxpipe/sources.yaml")
          expect(linked).toContain("# Owned by the team")
          expect(parse(linked)).toEqual({
            version: 1,
            sources: [
              {
                id: "issues",
                provider: "linear",
                connection: "con_linear_fixture",
                teams: ["ENG"],
              },
              {
                id: "linked-repositories",
                provider: "github",
                connection: f.connectionId,
                repositories: ["next/other"],
              },
            ],
          })

          // The same repository in another spelling changes nothing.
          expect(
            await run(
              `${jobId}_again`,
              "link",
              "git@github.com:Next/Other.git/",
            ),
          ).toMatchObject({ status: "completed", commitSha: null })

          // A repository outside GitHub cannot be linked.
          expect(
            await run(
              `${jobId}_gitlab`,
              "link",
              "https://gitlab.com/acme/tools",
            ),
          ).toMatchObject({ status: "failed" })

          expect(
            await run(
              `${jobId}_unlink`,
              "unlink",
              "https://github.com/next/other",
            ),
          ).toMatchObject({ status: "completed" })
          expect(parse(show(".ctxpipe/sources.yaml"))).toEqual(parse(sources))
          expect(show("repositories/other.md")).toBe(legacy.trim())
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
  "rejects credentials and invalid repository URLs before paused-job admission",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const { workspaceLinkUnlink } = await import(
          "../../openworkflow/workflows/workspace-link-unlink.js"
        )
        for (const [index, gitUrl] of [
          "https://fixture-secret@github.com/acme/app.git",
          "https://github.com/acme/app.git?token=fixture-secret",
          "not a repository URL",
        ].entries()) {
          const command = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_unsafe_${index}`,
            linkAction: "link" as const,
            linkGitUrl: gitUrl,
          }
          await expect(
            withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                { ...command, kind: "link_unlink" },
                {
                  error: (error) => {
                    throw error
                  },
                },
              ),
            ),
          ).rejects.toThrow()
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(command.jobId),
            ),
          ).toBeNull()
          await expect(
            f.runner.runWorkflow(workspaceLinkUnlink.spec, {
              ...command,
              revision: { ...f.revision, access: "write-default" },
            }),
          ).rejects.toThrow()
        }
        expect(
          f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
        ).toBe(f.sha)
      },
    )
  },
)

it(
  "binds a canonical paused link command to its native write workflow",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const jobId = `wjob_${f.id}_paused_link`
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "link_unlink",
                linkAction: "link",
                linkGitUrl: "git@github.com:Acme/API.git",
              },
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
        ).toMatchObject({
          status: "paused",
          commitSha: null,
          payload: {
            linkAction: "link",
            linkGitUrl: "https://github.com/acme/api",
            jobWorkspaceUrl: f.workspaceUrl,
          },
        })
        const { BackendPostgres } = await import("openworkflow/postgres")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        try {
          expect(
            (await backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) => (run.input as { jobId?: string })?.jobId === jobId,
            ),
          ).toMatchObject([
            { workflowName: "workspace-write-link-unlink", input: { jobId } },
          ])
        } finally {
          await backend.stop()
        }
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      },
    )
  },
)
