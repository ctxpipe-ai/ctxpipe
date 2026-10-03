import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { OpenWorkflow } from "openworkflow"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { listOrgLinkedRepositories } from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { githubSyncPullRequest } from "../../openworkflow/workflows/github-sync-pull-request.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceLinkUnlink } from "../../openworkflow/workflows/workspace-link-unlink.js"
import { maybeEnqueueGithubPrMirror } from "../../routes/webhooks/github/github-pr-mirror-events.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"

const SOURCE_URL = "https://github.com/fixture/source-app"
const SECOND_URL = "https://github.com/fixture/second-workspace.git"
const DECLARATION = `---\ngit: ${JSON.stringify(SOURCE_URL)}\n---\n`
const FILES = [
  { path: "repositories/source-app.md", body: DECLARATION },
  { path: "knowledge/owner.md", body: "# Owner text\n" },
]
const pullPath = (number: number) =>
  `github/pulls/fixture/source-app/${number}--${number * 10}.md`

function connection<T>(nodes: T[]) {
  return { pageInfo: { hasNextPage: false }, nodes }
}

/** A merged pull request as one GraphQL page returns it, relations inline. */
function graphqlPull(number: number) {
  return {
    databaseId: number * 10,
    number,
    url: `${SOURCE_URL}/pull/${number}`,
    title: `Ship change ${number}`,
    body: "",
    state: "MERGED",
    merged: true,
    isDraft: false,
    author: { login: "alice", __typename: "User" },
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefName: `feature-${number}`,
    headRefOid: "b".repeat(40),
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    mergedAt: "2026-03-02T00:00:00.000Z",
    labels: connection([]),
    reviewRequests: connection([]),
    files: connection([{ path: "src/app.ts", changeType: "MODIFIED" }]),
    reviews: connection([]),
    comments: connection([]),
    reviewThreads: connection([]),
  }
}

type GraphqlRequest = { query: string; variables: Record<string, unknown> }

/** GitHub GraphQL for the source repository; records every request. */
function serveSourceGraphql(
  f: NativeHydrationFixture,
  input: {
    merged: number[]
    pageSize: number
    failOnce?: (request: GraphqlRequest) => boolean
  },
) {
  const requests: GraphqlRequest[] = []
  const failed = new Set<string>()
  f.server.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const body = (await request.json()) as GraphqlRequest
      requests.push(body)
      const key = JSON.stringify(body.variables)
      if (input.failOnce?.(body) && !failed.has(key)) {
        failed.add(key)
        return HttpResponse.json({ errors: [{ message: "Fixture outage" }] })
      }
      if (body.query.includes("MergedPullRequests")) {
        const start = body.variables.after
          ? Number(String(body.variables.after).slice("cursor-".length))
          : 0
        const end = start + input.pageSize
        return HttpResponse.json({
          data: {
            repository: {
              pullRequests: {
                pageInfo: {
                  hasNextPage: end < input.merged.length,
                  endCursor: `cursor-${end}`,
                },
                nodes: input.merged.slice(start, end).map(graphqlPull),
              },
            },
          },
        })
      }
      const numbers = [...body.query.matchAll(/pr(\d+): pullRequest/g)].map(
        (match) => Number(match[1]),
      )
      return HttpResponse.json({
        data: {
          repository: Object.fromEntries(
            numbers.map((number) => [`pr${number}`, graphqlPull(number)]),
          ),
        },
      })
    }),
  )
  return requests
}

function mergedWebhook(number: number, repository = "fixture/source-app") {
  return {
    action: "closed",
    pull_request: {
      number,
      merged: true,
      draft: false,
      updated_at: `2026-03-${String(number).padStart(2, "0")}T00:00:00Z`,
    },
    repository: { full_name: repository },
    installation: { id: 123456789 },
  }
}

const filesIn = (f: NativeHydrationFixture, remote: string) =>
  f.git("--git-dir", remote, "ls-tree", "-r", "--name-only", "refs/heads/main")

it(
  "mirrors merged pull requests into every Workspace whose linked repositories include the repository",
  { timeout: 240_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        namespaceId: "default",
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: FILES,
      },
      async (f) => {
        const requests = serveSourceGraphql(f, { merged: [7], pageSize: 20 })
        const byNumber = () =>
          requests.filter((request) =>
            request.query.includes("PullRequestsByNumber"),
          ).length
        // Webhooks route by installation through the directory, as after install.
        const [row] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select()
            .from(connections)
            .where(eq(connections.id, f.connectionId)),
        )
        if (!row) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(row)

        // Workspace B starts with no linked repository.
        const workspaceA = f.workspaceId
        const workspaceB = `${f.workspaceId}_b`
        const sourceB = join(f.directory, "second-source")
        const remoteB = join(f.directory, "second.git")
        mkdirSync(join(sourceB, "knowledge"), { recursive: true })
        writeFileSync(join(sourceB, "knowledge/second.md"), "# Second\n")
        const gitB = (...args: string[]) =>
          execFileSync("git", args, { cwd: sourceB, encoding: "utf8" }).trim()
        gitB("init", "-b", "main")
        gitB("add", ".")
        gitB(
          "-c",
          "user.name=Contract",
          "-c",
          "user.email=contract@example.test",
          "commit",
          "-m",
          "Second workspace",
        )
        const shaB = gitB("rev-parse", "HEAD")
        gitB("clone", "--bare", "--no-local", sourceB, remoteB)
        f.git(
          "config",
          "--file",
          process.env.GIT_CONFIG_GLOBAL ?? "missing",
          "--add",
          `url.${remoteB}.insteadOf`,
          SECOND_URL,
        )
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaces).values({
            id: workspaceB,
            orgId: f.org.id,
            slug: "second",
            displayName: "Second",
            workspaceRepositoryUrl: SECOND_URL,
            githubConnectionId: f.connectionId,
            desiredSha: shaB,
            desiredGeneration: 1,
            desiredDefaultBranch: "main",
            indexedSha: shaB,
            writeStatus: "writable",
          }),
        )

        const runner = new OpenWorkflow({ backend: f.backend })
        runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
        runner.implementWorkflow(
          workspaceLinkUnlink.spec,
          workspaceLinkUnlink.fn,
        )
        runner.implementWorkflow(
          githubSyncPullRequest.spec,
          githubSyncPullRequest.fn,
        )
        runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = runner.newWorker({ concurrency: 2 })
        const mirrorRuns = async () =>
          (await f.backend.listWorkflowRuns({ limit: 200 })).data.filter(
            (run) =>
              run.workflowName === "github-sync-pull-request" &&
              (run.input as { orgId?: string }).orgId === f.org.id,
          )
        const settledMirrors = async (count: number) => {
          await expect
            .poll(
              async () =>
                (await mirrorRuns()).filter((run) =>
                  ["completed", "failed"].includes(run.status),
                ).length,
              { timeout: 60_000, interval: 250 },
            )
            .toBe(count)
          return mirrorRuns()
        }
        const linkedTo = async (workspaceId: string) =>
          withOrgIdContext(f.org, async () =>
            (await listOrgLinkedRepositories(f.org.id))
              .filter((linked) => linked.workspaceId === workspaceId)
              .map((linked) => linked.gitUrl),
          )
        const writeLink = async (
          jobId: string,
          linkAction: "link" | "unlink",
        ) => {
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: workspaceB,
                kind: "link_unlink",
                jobId,
                linkAction,
                linkGitUrl: SOURCE_URL,
              },
              {
                error: (error) => {
                  throw error
                },
              },
            ),
          )
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(jobId),
                ),
              { timeout: 60_000, interval: 250 },
            )
            .toMatchObject({ status: "completed" })
        }
        const webhook = (payload: unknown) =>
          maybeEnqueueGithubPrMirror({
            eventName: "pull_request",
            payload,
            githubConnectionId: f.connectionId,
          })
        try {
          await worker.start()

          // A's first hydrate learns the link declared in git and backfills it.
          await expect
            .poll(() => linkedTo(workspaceA), { timeout: 60_000 })
            .toEqual([SOURCE_URL])
          const [backfillA] = await settledMirrors(1)
          expect(backfillA).toMatchObject({
            status: "completed",
            input: { workspaceId: workspaceA, gitUrl: SOURCE_URL },
            output: { written: 1 },
          })
          expect(backfillA?.input).not.toHaveProperty("numbers")
          expect(filesIn(f, f.remote)).toContain(pullPath(7))

          // Linking B: its hydrate records the link and backfills B.
          await writeLink(`wjob_${f.id}_link`, "link")
          await expect
            .poll(() => linkedTo(workspaceB), { timeout: 60_000 })
            .toEqual([SOURCE_URL])
          const backfills = await settledMirrors(2)
          expect(
            backfills.find(
              (run) =>
                (run.input as { workspaceId: string }).workspaceId ===
                workspaceB,
            ),
          ).toMatchObject({ status: "completed", output: { written: 1 } })
          expect(filesIn(f, remoteB)).toContain(pullPath(7))

          // A replayed delivery is one job per Workspace, one request each.
          await webhook(mergedWebhook(8))
          await webhook(mergedWebhook(8))
          const merged = (await settledMirrors(4)).filter((run) =>
            (run.input as { numbers?: number[] }).numbers?.includes(8),
          )
          expect(
            merged
              .map((run) => (run.input as { workspaceId: string }).workspaceId)
              .sort(),
          ).toEqual([workspaceA, workspaceB].sort())
          for (const run of merged)
            expect(run).toMatchObject({
              status: "completed",
              input: { connectionId: f.connectionId },
              output: { written: 1 },
            })
          expect(byNumber()).toBe(2)
          for (const remote of [f.remote, remoteB])
            expect(filesIn(f, remote)).toContain(pullPath(8))

          // A repository no Workspace links starts nothing.
          await webhook(mergedWebhook(8, "fixture/unlinked-app"))
          expect(await mirrorRuns()).toHaveLength(4)

          // Unlinking B: new pull requests stop, earlier files stay.
          await writeLink(`wjob_${f.id}_unlink`, "unlink")
          expect(filesIn(f, remoteB)).not.toContain(
            "repositories/source-app.md",
          )
          await expect
            .poll(() => linkedTo(workspaceB), { timeout: 60_000 })
            .toEqual([])
          await webhook(mergedWebhook(9))
          const afterUnlink = (await settledMirrors(5)).filter((run) =>
            (run.input as { numbers?: number[] }).numbers?.includes(9),
          )
          expect(afterUnlink).toEqual([
            expect.objectContaining({
              status: "completed",
              input: expect.objectContaining({ workspaceId: workspaceA }),
            }),
          ])
          expect(filesIn(f, f.remote)).toContain(pullPath(9))
          const filesB = filesIn(f, remoteB)
          expect(filesB).not.toContain(pullPath(9))
          expect(filesB).toContain(pullPath(7))
          expect(filesB).toContain(pullPath(8))
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 200 }))
            .data) {
            if (!["completed", "failed", "canceled"].includes(run.status))
              await f.runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
          await withOrgDbContext(f.org.id, (db) =>
            db.delete(workspaces).where(eq(workspaces.id, workspaceB)),
          )
        }
      },
    )
  },
)

it(
  "backfills one GitHub request per page and replays a stored page without calling GitHub",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        namespaceId: "default",
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: FILES,
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const merged = Array.from({ length: 25 }, (_, index) => 30 - index)
        // The second page fails once, after the first page's step is stored.
        const requests = serveSourceGraphql(f, {
          merged,
          pageSize: 20,
          failOnce: (request) => request.variables.after === "cursor-20",
        })
        const runner = new OpenWorkflow({ backend: f.backend })
        runner.implementWorkflow(
          githubSyncPullRequest.spec,
          githubSyncPullRequest.fn,
        )
        runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const handle = await runner.runWorkflow(githubSyncPullRequest.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            gitUrl: SOURCE_URL,
          })
          await expect(handle.result({ timeoutMs: 60_000 })).resolves.toEqual({
            written: 25,
          })
          expect(requests.map((request) => request.variables.after)).toEqual([
            null,
            "cursor-20",
            "cursor-20",
          ])
          const attempts = (
            await f.backend.listStepAttempts({
              workflowRunId: handle.workflowRun.id,
            })
          ).data
            .filter((attempt) =>
              attempt.stepName.startsWith("mirror-github-pull-requests"),
            )
            .map((attempt) => [attempt.stepName, attempt.status])
          expect(attempts).toEqual(
            expect.arrayContaining([
              ["mirror-github-pull-requests:0", "completed"],
              ["mirror-github-pull-requests:1", "failed"],
              ["mirror-github-pull-requests:1", "completed"],
            ]),
          )
          expect(attempts).toHaveLength(3)
          const tree = filesIn(f, f.remote)
          for (const number of merged) expect(tree).toContain(pullPath(number))
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 200 }))
            .data) {
            if (!["completed", "failed", "canceled"].includes(run.status))
              await f.runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
        }
      },
    )
  },
)
