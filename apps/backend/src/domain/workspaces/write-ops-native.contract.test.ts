import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { workspaceOpsFolderMap } from "../../openworkflow/workflows/workspace-ops-folder-map.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it.each([
  ["orphan", "<!-- ctxpipe:folder-map -->\n## Folders\n- [docs/](docs/)\n"],
  [
    "duplicate",
    "<!-- ctxpipe:folder-map -->\n## Folders\n- [docs/](docs/)\n<!-- /ctxpipe:folder-map -->\n<!-- ctxpipe:folder-map -->\n## Folders again\n- [docs/](docs/)\n<!-- /ctxpipe:folder-map -->\n",
  ],
])(
  "fails safely for %s folder markers instead of claiming convergence",
  { timeout: 30_000 },
  async (_name, body) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "AGENTS.md", body },
          { path: "docs/intro.md", body: "# Introduction\n" },
        ],
      },
      async (f) => {
        const spec = {
          ...workspaceOpsFolderMap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceOpsFolderMap.fn)
        const worker = f.runner.newWorker({ concurrency: 1 })
        const jobId = `wjob_${f.id}_markers`
        try {
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
          })
          await worker.start()
          await expect(handle.result({ timeoutMs: 15_000 })).rejects.toThrow()
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(jobId),
            ),
          ).toMatchObject({ status: "failed", commitSha: null })
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
          expect(
            f.git("--git-dir", f.remote, "show", "refs/heads/main:AGENTS.md"),
          ).toBe(body.trim())
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "preserves ambiguous folder instructions and appends a dedicated folder map",
  { timeout: 30_000 },
  async () => {
    const instructions =
      "# Working instructions\n\n## Cleanup rules\n- `tmp/` must never be committed\n\n## Folders to clean\n- `tmp/`\n\n## Review\nRead the changes carefully.\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "AGENTS.md", body: instructions },
          { path: "docs/intro.md", body: "# Introduction\n" },
        ],
      },
      async (f) => {
        f.runner.implementWorkflow(
          workspaceOpsFolderMap.spec,
          workspaceOpsFolderMap.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          const handle = await f.runner.runWorkflow(
            workspaceOpsFolderMap.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_instructions`,
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
            "refs/heads/main:AGENTS.md",
          )
          expect(markdown).toContain(instructions.trim())
          expect(
            markdown.indexOf("<!-- ctxpipe:folder-map -->"),
          ).toBeGreaterThan(markdown.indexOf("Read the changes carefully."))
          expect(markdown).toContain("- [docs/](docs/)")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "carries a workspace rename from HTTP through its Git commit and native hydrate",
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
            body: '---\nname: "Original: docs"\ncustom: [keep, me]\n---\n\n## Our folders\n- [Docs](docs/)\n\n## Preferences\nKeep these instructions.\n',
          },
          { path: "docs/intro.md", body: "# Introduction\n" },
        ],
      },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        const { workspaceHydrate } = await import(
          "../../openworkflow/workflows/workspace-hydrate.js"
        )
        runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
        const { workspaceRoutes } = await import(
          "../../routes/v1/workspaces.js"
        )
        const { workspaceHttpApp } = await import(
          "../../test/workspace-http-fixture.js"
        )
        const { getWorkspaceById } = await import("../../models/workspaces.js")
        const { parse } = await import("yaml")
        runner.implementWorkflow(
          workspaceOpsFolderMap.spec,
          workspaceOpsFolderMap.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          const response = await workspaceHttpApp(
            f.org,
            workspaceRoutes,
          ).request("/workspaces/knowledge", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              displayName: "Renamed: docs",
              slug: "renamed-docs",
            }),
          })
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ slug: "renamed-docs" })
          const admission = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) =>
              run.workflowName === "workspace-write-ops-folder-map" &&
              (run.input as { workspaceId?: string })?.workspaceId ===
                f.workspaceId,
          )
          expect(admission?.input).toMatchObject({
            displayName: "Renamed: docs",
          })
          if (!admission) throw new Error("Rename command was not admitted")
          const renameJobId = (admission.input as { jobId: string }).jobId
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(renameJobId),
                ),
              { timeout: 15_000 },
            )
            .toMatchObject({ status: "completed" })
          expect(
            f.git("--git-dir", f.remote, "show", "refs/heads/main:AGENTS.md"),
          ).toContain('name: "Renamed: docs"')
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () =>
                    (await getWorkspaceById(f.workspaceId))?.displayName,
                ),
              { timeout: 30_000 },
            )
            .toBe("Renamed: docs")
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "refs/heads/main:AGENTS.md",
          )
          expect(parse(markdown.split("---")[1] ?? "")).toEqual({
            name: "Renamed: docs",
            custom: ["keep", "me"],
          })
          expect(markdown).toContain("## Preferences\nKeep these instructions.")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
          const jobs = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              run.workflowName === "workspace-write-ops-folder-map" &&
              (run.input as { workspaceId?: string })?.workspaceId ===
                f.workspaceId,
          )
          expect(jobs).toHaveLength(1)
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(
                (jobs[0]?.input as { jobId: string }).jobId,
              ),
            ),
          ).toMatchObject({ status: "completed" })
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
