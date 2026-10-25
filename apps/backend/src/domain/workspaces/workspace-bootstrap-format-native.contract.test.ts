import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceBootstrap } from "../../openworkflow/workflows/workspace-bootstrap.js"
import { workspaceSemanticMerge } from "../../openworkflow/workflows/workspace-semantic-merge.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { changeWorkspaceSource } from "../workspace-sources/service.js"
import { WORKSPACE_FORMAT_PATH } from "./workspace-format.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

const README = "# Example\nA new repository.\n"

/**
 * Publish the fixture tree, then run the bound bootstrap workflow once for
 * each job id at the same time, on the same tip. It returns the results in
 * job order.
 */
async function bootstrapTogether(
  f: NativeHydrationFixture,
  jobs: string[],
  /** Runs after the bind and before the worker starts the runs. */
  beforeStart?: () => void,
) {
  const spec = {
    ...workspaceBootstrap.spec,
    retryPolicy: { maximumAttempts: 1 },
  }
  f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
  f.runner.implementWorkflow(
    workspaceSemanticMerge.spec,
    workspaceSemanticMerge.fn,
  )
  await f.publish()
  await f.worker.stop()
  const worker = f.runner.newWorker({ concurrency: jobs.length })
  try {
    const handles = []
    for (const [index, job] of jobs.entries()) {
      // Git commit times have a resolution of one second. A second run in
      // a later second makes a different commit, so its push loses the race.
      if (index) await new Promise((resolve) => setTimeout(resolve, 1_100))
      handles.push(
        await f.runner.runWorkflow(spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_${job}`,
          revision: { ...f.revision, access: "write-default" },
        }),
      )
    }
    // Both runs bind the same tip before the worker starts either of them.
    beforeStart?.()
    await worker.start()
    return await Promise.all(
      handles.map((handle) =>
        handle.result({ timeoutMs: 45_000 }).catch(async (error) => {
          const steps = await f.backend.listStepAttempts({
            workflowRunId: handle.workflowRun.id,
          })
          throw new Error(
            JSON.stringify({
              error: String(error),
              steps: steps.data.map((step) => [step.stepName, step.error]),
            }),
          )
        }),
      ),
    )
  } finally {
    await worker.stop()
  }
}

/**
 * Publish the fixture tree, then admit one bootstrap through the production
 * queue, as a new Workspace does. It returns the admission and the final job
 * status (null when admission refused the job).
 */
async function admitBootstrap(f: NativeHydrationFixture) {
  await f.publish()
  await f.worker.stop()
  const backend = await BackendPostgres.connect(f.databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  const runner = new OpenWorkflow({ backend })
  runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
  runner.implementWorkflow(
    workspaceSemanticMerge.spec,
    workspaceSemanticMerge.fn,
  )
  const worker = runner.newWorker({ concurrency: 1 })
  try {
    const jobId = `wjob_${f.id}_admitted`
    const errors: Error[] = []
    const admitted = await withOrgIdContext(f.org, () =>
      enqueueWriteJob(
        {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId,
          kind: "bootstrap",
        },
        { error: (error) => errors.push(error) },
      ),
    )
    expect(errors).toEqual([])
    if (!admitted.started) return { admitted, status: null }
    await worker.start()
    const status = () =>
      withOrgIdContext(
        f.org,
        async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
      )
    await expect.poll(status, { timeout: 30_000 }).toBe("completed")
    return { admitted, status: await status() }
  } finally {
    await worker.stop()
    await backend.stop()
  }
}

const tip = (f: NativeHydrationFixture) =>
  f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main")

/** The file at `path` on the remote default branch, or null. */
function remoteFile(f: NativeHydrationFixture, path: string): string | null {
  try {
    return execFileSync(
      "git",
      ["--git-dir", f.remote, "show", `refs/heads/main:${path}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
  } catch {
    return null
  }
}

it(
  "bootstraps a repository with only a README at the newest format and keeps the README",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "README.md", body: README }],
      },
      async (f) => {
        expect(await admitBootstrap(f)).toEqual({
          admitted: { started: true },
          status: "completed",
        })
        expect(
          f.git("--git-dir", f.remote, "rev-list", "--count", `${f.sha}..main`),
        ).toBe("1")
        expect(f.git("--git-dir", f.remote, "rev-parse", "main^")).toBe(f.sha)
        expect(remoteFile(f, WORKSPACE_FORMAT_PATH)).toContain("format: 3\n")
        expect(remoteFile(f, "README.md")).toBe(README)
        expect(remoteFile(f, "AGENTS.md")).toContain("name: Hydration contract")
      },
    )
  },
)

it(
  "does not change a format 0 repository that has sources",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "README.md", body: README },
          {
            path: "sources/linear/eng.md",
            body: "---\nprovider: linear\nconnection: con_linear\nteams: [ENG]\n---\n",
          },
        ],
      },
      async (f) => {
        // The upgrade pull request changes this repository, not bootstrap.
        expect(await admitBootstrap(f)).toEqual({
          admitted: { started: false },
          status: null,
        })
        expect(tip(f)).toBe(f.sha)
        expect(remoteFile(f, WORKSPACE_FORMAT_PATH)).toBeNull()
      },
    )
  },
)

it(
  "makes one bootstrap commit when two bootstraps run at the same time",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "README.md", body: README }],
      },
      async (f) => {
        const results = await bootstrapTogether(f, ["first", "second"])
        expect(
          f.git("--git-dir", f.remote, "rev-list", "--count", `${f.sha}..main`),
        ).toBe("1")
        const head = tip(f)
        // Either run can win. The push of the other loses the race, and its
        // merge finds the same files on the new tip.
        expect(results).toHaveLength(2)
        expect(results).toEqual(
          expect.arrayContaining([
            { committed: true, commitSha: head },
            { committed: false, reason: "no_changes" },
          ]),
        )
        expect(remoteFile(f, WORKSPACE_FORMAT_PATH)).toContain("format: 3\n")
        expect(remoteFile(f, "README.md")).toBe(README)
      },
    )
  },
)

it(
  "adds a source to a bootstrapped repository that had only a README",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "README.md", body: README }],
        onGithubPullRequest: () => {},
      },
      async (f) => {
        await admitBootstrap(f)
        const head = tip(f)
        expect(remoteFile(f, WORKSPACE_FORMAT_PATH)).toContain("format: 3\n")
        const linear = `con_linear_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(connections).values({
            id: linear,
            orgId: f.org.id,
            type: "linear",
            config: {
              status: "installed",
              workspaceId: "linear-org",
              workspaceName: "Example",
            },
          }),
        )
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
          // GitHub reads of the default branch come from the real remote.
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/git/trees/:sha",
            () =>
              HttpResponse.json({
                sha: head,
                truncated: false,
                tree: f
                  .git(
                    "--git-dir",
                    f.remote,
                    "ls-tree",
                    "-r",
                    "--name-only",
                    "main",
                  )
                  .split("\n")
                  .map((path) => ({ path, type: "blob", sha: "c".repeat(40) })),
              }),
          ),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/contents/*",
            ({ params }) => {
              const content = remoteFile(f, String(params[0]))
              return content === null
                ? HttpResponse.json({ message: "Not found" }, { status: 404 })
                : HttpResponse.json({
                    type: "file",
                    encoding: "base64",
                    content: Buffer.from(content).toString("base64"),
                  })
            },
          ),
          http.all(
            "https://api.github.com/repos/fixture/hydration-contract/git/*",
            ({ request, params }) => {
              if (request.method !== "GET")
                return HttpResponse.json({ sha: "e".repeat(40) })
              return String(params[0]).startsWith("ref/heads/")
                ? HttpResponse.json({ object: { sha: head } })
                : HttpResponse.json({ tree: { sha: "b".repeat(40) } })
            },
          ),
        )
        const result = await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Missing fixture Workspace")
          return changeWorkspaceSource({
            workspace,
            change: {
              action: "add",
              path: "sources/linear/eng.md",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
            },
          })
        })
        expect(result).toMatchObject({
          outcome: "pull_request",
          path: "sources/linear/eng.md",
        })
      },
    )
  },
)

it(
  "does not write the format file when sources arrive on the default branch after the bind",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "README.md", body: README }],
      },
      async (f) => {
        let human = ""
        const [result] = await bootstrapTogether(f, ["only"], () => {
          // A person pushes a source file at the old layout.
          mkdirSync(join(f.directory, "sources/linear"), { recursive: true })
          writeFileSync(
            join(f.directory, "sources/linear/eng.md"),
            "---\nprovider: linear\nconnection: con_linear\nteams: [ENG]\n---\n",
          )
          f.git("add", ".")
          f.git(
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "Add a source",
          )
          f.git("push", f.remote, "HEAD:refs/heads/main")
          human = f.git("rev-parse", "HEAD")
        })
        expect(result).toMatchObject({ committed: true })
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "merge-base",
            "--is-ancestor",
            human,
            "main",
          ),
        ).toBe("")
        expect(remoteFile(f, WORKSPACE_FORMAT_PATH)).toBeNull()
        expect(remoteFile(f, "AGENTS.md")).toContain("name: Hydration contract")
      },
    )
  },
)
