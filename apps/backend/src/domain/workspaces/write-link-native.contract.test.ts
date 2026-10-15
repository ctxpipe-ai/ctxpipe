import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { listWorkspaceSources } from "../workspace-sources/service.js"

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
          // Link edits sources.yaml; it keeps the comment and the other
          // entry. The GitHub repository file moves into the file with its
          // branch as ref (the ADR-050 upgrade of a converted Workspace).
          expect(tree()).toEqual([".ctxpipe/sources.yaml"])
          const linked = show(".ctxpipe/sources.yaml")
          expect(linked).toContain("# Owned by the team")
          const issues = {
            id: "issues",
            provider: "linear",
            connection: "con_linear_fixture",
            teams: ["ENG"],
          }
          expect(parse(linked)).toEqual({
            version: 1,
            sources: [
              issues,
              {
                id: "linked-repositories",
                provider: "github",
                connection: f.connectionId,
                repositories: [
                  { name: "old/other", ref: "stable" },
                  "next/other",
                ],
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

          // A repository outside GitHub cannot be linked; the job keeps why.
          expect(
            await run(
              `${jobId}_gitlab`,
              "link",
              "https://gitlab.com/acme/tools",
            ),
          ).toMatchObject({
            status: "failed",
            payload: {
              failureReason:
                "Only a GitHub repository can be linked to a Workspace",
            },
          })
          // The Sources list shows why, with the source errors.
          const refused = {
            action: "link",
            gitUrl: "https://gitlab.com/acme/tools",
            reason: "Only a GitHub repository can be linked to a Workspace",
          }
          // No source pull request is open.
          f.server.use(
            http.get(
              "https://api.github.com/repos/fixture/hydration-contract/pulls",
              () => HttpResponse.json([]),
            ),
          )
          const linkErrors = () =>
            withOrgIdContext(f.org, async () => {
              const workspace = await getWorkspaceById(f.workspaceId)
              if (!workspace) throw new Error("Missing fixture Workspace")
              return (await listWorkspaceSources(workspace)).linkErrors
            })
          expect(await linkErrors()).toEqual([
            { ...refused, failedAt: expect.any(String) },
          ])

          expect(
            await run(
              `${jobId}_unlink`,
              "unlink",
              "https://github.com/next/other",
            ),
          ).toMatchObject({ status: "completed" })
          // A later edit of another repository keeps the refused one shown.
          expect(await linkErrors()).toMatchObject([refused])
          expect(parse(show(".ctxpipe/sources.yaml"))).toEqual({
            version: 1,
            sources: [
              issues,
              {
                id: "linked-repositories",
                provider: "github",
                connection: f.connectionId,
                repositories: [{ name: "old/other", ref: "stable" }],
              },
            ],
          })
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
  "makes the same link edit again on the new tip after a lost push race, without a semantic merge",
  { timeout: 60_000 },
  async () => {
    const entry = (id: string, repository: string) =>
      `  - id: ${id}\n    provider: github\n    connection: CONNECTION\n    repositories: [${repository}]\n`
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        try {
          const { workspaceLinkUnlink } = await import(
            "../../openworkflow/workflows/workspace-link-unlink.js"
          )
          // Only the link workflow runs: a semantic merge child never starts.
          runner.implementWorkflow(
            workspaceLinkUnlink.spec,
            workspaceLinkUnlink.fn,
          )
          // Another writer wins the race: the tip moves after the job took
          // its revision.
          mkdirSync(join(f.directory, ".ctxpipe"), { recursive: true })
          writeFileSync(
            join(f.directory, ".ctxpipe/sources.yaml"),
            `version: 1\nsources:\n${entry("team", "acme/team")}`.replace(
              "CONNECTION",
              f.connectionId,
            ),
          )
          f.git("add", "--", ".ctxpipe/sources.yaml")
          f.git(
            "-c",
            "user.name=Contract",
            "-c",
            "user.email=contract@example.test",
            "commit",
            "-m",
            "Link the team repository",
          )
          f.git("push", f.remote, "HEAD:main")
          const jobId = `wjob_${f.id}_race`
          const handle = await runner.runWorkflow(workspaceLinkUnlink.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
            linkAction: "link",
            linkGitUrl: "https://github.com/acme/web",
          })
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          expect(await handle.result({ timeoutMs: 45_000 })).toMatchObject({
            committed: true,
          })
          expect(
            parse(
              f.git(
                "--git-dir",
                f.remote,
                "show",
                "refs/heads/main:.ctxpipe/sources.yaml",
              ),
            ).sources,
          ).toEqual([
            {
              id: "team",
              provider: "github",
              connection: f.connectionId,
              repositories: ["acme/team", "acme/web"],
            },
          ])
          expect(f.semanticRequests).toEqual([])
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(jobId),
            ),
          ).toMatchObject({ status: "completed" })
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "keeps a commit that lands after the new tip was read, and makes the link edit again on top of it",
  { timeout: 90_000 },
  async () => {
    const entry = (id: string, repository: string) =>
      `  - id: ${id}\n    provider: github\n    connection: CONNECTION\n    repositories: [${repository}]\n`
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const commit = (message: string) =>
          f.git(
            "-c",
            "user.name=Contract",
            "-c",
            "user.email=contract@example.test",
            "commit",
            "-m",
            message,
          )
        try {
          const { workspaceLinkUnlink } = await import(
            "../../openworkflow/workflows/workspace-link-unlink.js"
          )
          runner.implementWorkflow(
            workspaceLinkUnlink.spec,
            workspaceLinkUnlink.fn,
          )
          // Another writer wins the first race, so the job reads the new tip.
          mkdirSync(join(f.directory, ".ctxpipe"), { recursive: true })
          writeFileSync(
            join(f.directory, ".ctxpipe/sources.yaml"),
            `version: 1\nsources:\n${entry("team", "acme/team")}`.replace(
              "CONNECTION",
              f.connectionId,
            ),
          )
          f.git("add", "--", ".ctxpipe/sources.yaml")
          commit("Link the team repository")
          f.git("push", f.remote, "HEAD:main")
          // A person writes on top of that tip. Their commit lands on main
          // during the first push of the job, after the job read the new tip
          // and staged its edit again: the last moment before the ref update.
          writeFileSync(join(f.directory, "human.md"), "# Human\nA note.\n")
          f.git("add", "--", "human.md")
          commit("Add a note by hand")
          const human = f.git("rev-parse", "HEAD")
          f.git("push", f.remote, "HEAD:refs/heads/human-staging")
          const landed = join(f.directory, "human-landed")
          const hook = join(f.remote, "hooks", "pre-receive")
          writeFileSync(
            hook,
            [
              "#!/bin/sh",
              "cat >/dev/null",
              `if [ ! -e '${landed}' ]; then`,
              `  touch '${landed}'`,
              "  env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\",
              `    git --git-dir='${f.remote}' update-ref refs/heads/main ${human}`,
              "fi",
              "",
            ].join("\n"),
            { mode: 0o755 },
          )
          const jobId = `wjob_${f.id}_human`
          const handle = await runner.runWorkflow(workspaceLinkUnlink.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
            linkAction: "link",
            linkGitUrl: "https://github.com/acme/web",
          })
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
            committed: true,
          })
          expect(existsSync(landed)).toBe(true)
          const show = (path: string) =>
            f.git("--git-dir", f.remote, "show", `refs/heads/main:${path}`)
          // The human commit is still on main, under the link edit.
          f.git(
            "--git-dir",
            f.remote,
            "merge-base",
            "--is-ancestor",
            human,
            "refs/heads/main",
          )
          expect(show("human.md")).toBe("# Human\nA note.")
          expect(parse(show(".ctxpipe/sources.yaml")).sources).toEqual([
            {
              id: "team",
              provider: "github",
              connection: f.connectionId,
              repositories: ["acme/team", "acme/web"],
            },
          ])
          expect(f.semanticRequests).toEqual([])
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(jobId),
            ),
          ).toMatchObject({ status: "completed" })
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

it(
  "hydrate of an exported Workspace moves its repository files into sources.yaml, and the links project",
  { timeout: 90_000 },
  async () => {
    // The export of an earlier version left `repositories/*.md` files and no
    // GitHub entry in sources.yaml (for example, on a preview database).
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "notes.md", body: "# Notes\nTeam notes.\n" },
          {
            path: "repositories/web.md",
            body: "---\ngit: https://github.com/acme/web.git\n---\n\nThe web app.\n",
          },
          {
            path: "repositories/api.md",
            body: "---\ngit: https://github.com/acme/api.git\nbranch: stable\n---\n",
          },
        ],
      },
      async (f) => {
        // A second worker also runs the link edit that hydrate plans.
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { workspaceLinkUnlink } = await import(
          "../../openworkflow/workflows/workspace-link-unlink.js"
        )
        const { workspaceHydrate } = await import(
          "../../openworkflow/workflows/workspace-hydrate.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
        runner.implementWorkflow(
          workspaceLinkUnlink.spec,
          workspaceLinkUnlink.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        await worker.start()
        await f.worker.start()
        try {
          await f.handle.result({ timeoutMs: 30_000 })
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
          await expect
            .poll(() => tree().includes(".ctxpipe/sources.yaml"), {
              timeout: 45_000,
            })
            .toBe(true)
          expect(
            tree().filter((path) => path.startsWith("repositories/")),
          ).toEqual([])
          expect(parse(show(".ctxpipe/sources.yaml"))).toMatchObject({
            version: 1,
            sources: [
              {
                provider: "github",
                connection: f.connectionId,
                repositories: expect.arrayContaining([
                  "acme/web",
                  { name: "acme/api", ref: "stable" },
                ]),
              },
            ],
          })
          expect(show("notes.md")).toBe("# Notes\nTeam notes.")
          expect(f.semanticRequests).toEqual([])
          // The hydrate of the new commit projects the links.
          const { listLinkedRepositoryPins } = await import(
            "../../models/workspace-source-state.js"
          )
          const { withOrgDbContext } = await import("../../db/client.js")
          await expect
            .poll(
              async () =>
                (
                  await withOrgDbContext(f.org.id, (db) =>
                    listLinkedRepositoryPins(db, {
                      workspaceId: f.workspaceId,
                    }),
                  )
                )
                  .map((pin) => `${pin.gitUrl}@${pin.desiredRef ?? ""}`)
                  .sort(),
              { timeout: 45_000 },
            )
            .toEqual([
              "https://github.com/acme/api@stable",
              "https://github.com/acme/web@",
            ])
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
