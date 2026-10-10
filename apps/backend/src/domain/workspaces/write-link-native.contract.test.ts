import { expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it.each([
  { label: "unknown", writeStatus: undefined },
  { label: "writable", writeStatus: "writable" as const },
])(
  "persists a canonical HTTP link command from $label access",
  { timeout: 30_000 },
  async ({ writeStatus }) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus },
      async (f) => {
        const { workspaceLinkedRoutes } = await import(
          "../../routes/v1/workspace-linked-routes.js"
        )
        const { workspaceHttpApp } = await import(
          "../../test/workspace-http-fixture.js"
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const response = await workspaceHttpApp(
            f.org,
            workspaceLinkedRoutes,
          ).request("/workspaces/knowledge/linked-repositories", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gitUrl: "https://github.com/Acme/App.git" }),
          })
          expect(response.status).toBe(202)
          expect(await response.json()).toEqual({
            queued: true,
            action: "link",
            gitUrl: "https://github.com/acme/app",
          })
          await expect
            .poll(
              async () =>
                (await backend.listWorkflowRuns({ limit: 100 })).data.find(
                  (run) =>
                    run.workflowName === "workspace-write-link-unlink" &&
                    (run.input as { workspaceId?: string })?.workspaceId ===
                      f.workspaceId,
                ),
              { timeout: 15_000 },
            )
            .toMatchObject({
              workflowName: "workspace-write-link-unlink",
              input: {
                workspaceId: f.workspaceId,
                linkGitUrl: "https://github.com/acme/app",
                linkAction: "link",
                revision: { sha: f.sha, access: "write-default" },
              },
            })
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

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
            input: {
              linkAction: "link",
              linkGitUrl: "https://github.com/next/other",
            },
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
          ).toEqual({ git: "https://github.com/next/other" })
          const noOpId = `${jobId}_again`
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  ...command,
                  jobId: noOpId,
                  linkAction: "link",
                  linkGitUrl: "git@github.com:Next/Other.git/",
                },
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

it(
  "rejects credentials and invalid repository URLs before HTTP or paused-job admission",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const { workspaceLinkedRoutes } = await import(
          "../../routes/v1/workspace-linked-routes.js"
        )
        const { workspaceHttpApp } = await import(
          "../../test/workspace-http-fixture.js"
        )
        const { workspaceLinkUnlink } = await import(
          "../../openworkflow/workflows/workspace-link-unlink.js"
        )
        const app = workspaceHttpApp(f.org, workspaceLinkedRoutes)
        for (const [index, gitUrl] of [
          "https://fixture-secret@github.com/acme/app.git",
          "https://github.com/acme/app.git?token=fixture-secret",
          "not a repository URL",
        ].entries()) {
          const response = await app.request(
            "/workspaces/knowledge/linked-repositories",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ gitUrl }),
            },
          )
          expect(response.status).toBe(400)
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
  "hydrates one GitHub remote across case variants and rejects duplicate or self links over HTTP",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "repositories/first.md",
            body: "---\ngit: git@github.com:Acme/App.git/\n---\n",
          },
          {
            path: "repositories/second.md",
            body: "---\ngit: https://github.com/acme/app\n---\n",
          },
        ],
      },
      async (f) => {
        const { workspaceLinkedRoutes } = await import(
          "../../routes/v1/workspace-linked-routes.js"
        )
        const { workspaceHttpApp } = await import(
          "../../test/workspace-http-fixture.js"
        )
        const { listLinkedRepositories } = await import(
          "../../models/workspaces.js"
        )
        await f.worker.start()
        expect(await f.handle.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
          units: 0,
          skipped: 1,
        })
        const linked = await withOrgIdContext(f.org, () =>
          listLinkedRepositories(f.workspaceId),
        )
        expect(linked.map((row) => row.gitUrl)).toEqual([
          "https://github.com/acme/app",
        ])
        const app = workspaceHttpApp(f.org, workspaceLinkedRoutes)
        for (const gitUrl of [
          "https://github.com/ACME/APP.git",
          "https://github.com/Fixture/Hydration-Contract.git",
        ]) {
          const response = await app.request(
            "/workspaces/knowledge/linked-repositories",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ gitUrl }),
            },
          )
          expect(response.status).toBe(409)
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
