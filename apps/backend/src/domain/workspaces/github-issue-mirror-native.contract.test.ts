import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { OpenWorkflow } from "openworkflow"
import { expect, it } from "vitest"

import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { githubSyncIssue } from "../../openworkflow/workflows/github-sync-issue.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { maybeEnqueueGithubIssueMirror } from "../../routes/webhooks/github/github-issue-mirror-events.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { cancelWorkflowRunIfOpen } from "../../test/open-workflow-runs.js"

const SOURCE_URL = "https://github.com/fixture/source-app"
// The fixture puts its GitHub connection id in place of `{{connectionId}}`.
const SOURCES =
  'version: 1\nsources:\n  - id: linked-repositories\n    provider: github\n    connection: "{{connectionId}}"\n    repositories: [fixture/source-app]\n'
const FILES = [
  { path: ".ctxpipe/sources.yaml", body: SOURCES },
  { path: "knowledge/owner.md", body: "# Owner text\n" },
]
const issuePath = (number: number) =>
  `github/issues/fixture/source-app/${number}.md`

function graphqlIssue(number: number, title = `Problem ${number}`) {
  return {
    id: `I_${number}`,
    number,
    url: `${SOURCE_URL}/issues/${number}`,
    title,
    body: "Steps to see it.",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
    closedAt: null,
    author: { login: "alice", __typename: "User" },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    closedByPullRequestsReferences: { nodes: [] },
  }
}

type GraphqlRequest = { query: string; variables: Record<string, unknown> }

/** GitHub GraphQL for the issues of the source repository; records each request. */
function serveIssues(
  f: NativeHydrationFixture,
  issues: Map<number, ReturnType<typeof graphqlIssue>>,
) {
  const requests: GraphqlRequest[] = []
  f.server.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const body = (await request.json()) as GraphqlRequest
      if (body.query.includes("GithubIssuePage")) {
        requests.push(body)
        return HttpResponse.json({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [...issues.values()],
              },
            },
          },
        })
      }
      if (body.query.includes("query GithubIssue(")) {
        requests.push(body)
        const issue = issues.get(Number(body.variables.number))
        return HttpResponse.json(
          issue
            ? { data: { repository: { issue } } }
            : {
                data: { repository: { issue: null } },
                errors: [
                  {
                    type: "NOT_FOUND",
                    path: ["repository", "issue"],
                    message: "Could not resolve to an Issue",
                  },
                ],
              },
        )
      }
      // The pull request backfill of the same link finds nothing.
      return HttpResponse.json({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      })
    }),
  )
  return requests
}

const filesIn = (f: NativeHydrationFixture) =>
  f.git(
    "--git-dir",
    f.remote,
    "ls-tree",
    "-r",
    "--name-only",
    "refs/heads/main",
  )

const fixtureOptions = {
  namespaceId: openWorkflowNamespaceId(),
  github: true,
  githubWriteView: "writable",
  writeStatus: "writable",
  files: FILES,
} as const

/** A worker for hydrate, the issue mirror and the mirror write. */
async function startWorker(f: NativeHydrationFixture) {
  const runner = new OpenWorkflow({ backend: f.backend })
  runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
  runner.implementWorkflow(workspaceTipCheck.spec, workspaceTipCheck.fn)
  runner.implementWorkflow(githubSyncIssue.spec, githubSyncIssue.fn)
  runner.implementWorkflow(
    workspaceConnectorMirror.spec,
    workspaceConnectorMirror.fn,
  )
  const worker = runner.newWorker({ concurrency: 2 })
  await worker.start()
  return worker
}

async function stopAll(
  f: NativeHydrationFixture,
  worker: { stop: () => Promise<void> },
) {
  for (const run of (await f.backend.listWorkflowRuns({ limit: 200 })).data) {
    if (!["completed", "failed", "canceled"].includes(run.status))
      await cancelWorkflowRunIfOpen(f.backend, run.id)
  }
  await worker.stop()
}

const issueRuns = async (f: NativeHydrationFixture) =>
  (await f.backend.listWorkflowRuns({ limit: 200 })).data.filter(
    (run) =>
      run.workflowName === "github-sync-issue" &&
      (run.input as { orgId?: string }).orgId === f.org.id,
  )

async function settledIssueRuns(f: NativeHydrationFixture, count: number) {
  await expect
    .poll(
      async () =>
        (await issueRuns(f)).filter((run) =>
          ["completed", "failed"].includes(run.status),
        ).length,
      { timeout: 60_000, interval: 250 },
    )
    .toBe(count)
  return issueRuns(f)
}

it(
  "backfills the issues of a linked repository, then applies issue webhooks",
  { timeout: 240_000 },
  async () => {
    await withNativeHydrationFixture(fixtureOptions, async (f) => {
      const issues = new Map([
        [3, graphqlIssue(3)],
        [4, graphqlIssue(4)],
      ])
      const requests = serveIssues(f, issues)
      // Webhooks route by installation through the directory, as after install.
      const [row] = await withOrgDbContext(f.org.id, (db) =>
        db.select().from(connections).where(eq(connections.id, f.connectionId)),
      )
      if (!row) throw new Error("Fixture connection missing")
      await upsertConnectionDirectory(row)
      const webhook = (action: string, number: number, updatedAt: string) =>
        maybeEnqueueGithubIssueMirror({
          eventName: "issues",
          payload: {
            action,
            issue: { number, updated_at: updatedAt },
            repository: { full_name: "fixture/source-app" },
            installation: { id: 123456789 },
          },
          githubConnectionId: f.connectionId,
        })
      const worker = await startWorker(f)
      try {
        // The first hydrate learns the link declared in Git and backfills it.
        const [backfill] = await settledIssueRuns(f, 1)
        expect(backfill).toMatchObject({
          status: "completed",
          input: { workspaceId: f.workspaceId, gitUrl: SOURCE_URL },
          output: { written: 2 },
        })
        expect(backfill?.input).not.toHaveProperty("number")
        expect(filesIn(f)).toContain(issuePath(3))
        expect(filesIn(f)).toContain(issuePath(4))
        const mirrored = f.git(
          "--git-dir",
          f.remote,
          "show",
          `refs/heads/main:${issuePath(3)}`,
        )
        expect(mirrored).toContain("type: issue")
        expect(mirrored).toContain(`url: ${SOURCE_URL}/issues/3`)
        // The sources stamp names the source file of the repository (ADR-050).
        expect(mirrored).toMatch(/\nsources:\n {2}- /)

        // A replayed delivery is one run and one request.
        issues.set(3, graphqlIssue(3, "Problem 3, renamed"))
        await webhook("edited", 3, "2026-03-05T00:00:00Z")
        await webhook("edited", 3, "2026-03-05T00:00:00Z")
        const edited = (await settledIssueRuns(f, 2)).filter(
          (run) => (run.input as { number?: number }).number === 3,
        )
        expect(edited).toEqual([
          expect.objectContaining({
            status: "completed",
            input: expect.objectContaining({ connectionId: f.connectionId }),
          }),
        ])
        expect(
          requests.filter((request) => request.variables.number === 3),
        ).toHaveLength(1)
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "show",
            `refs/heads/main:${issuePath(3)}`,
          ),
        ).toContain("# Problem 3, renamed")

        // A deleted issue removes its file.
        issues.delete(4)
        await webhook("deleted", 4, "2026-03-02T00:00:00Z")
        const [deleted] = (await settledIssueRuns(f, 3)).filter(
          (run) => (run.input as { number?: number }).number === 4,
        )
        expect(deleted).toMatchObject({
          status: "completed",
          output: { deleted: 1 },
        })
        expect(filesIn(f)).not.toContain(issuePath(4))
        expect(filesIn(f)).toContain(issuePath(3))

        // A repository that no Workspace links starts nothing.
        await maybeEnqueueGithubIssueMirror({
          eventName: "issues",
          payload: {
            action: "opened",
            issue: { number: 1, updated_at: "2026-03-06T00:00:00Z" },
            repository: { full_name: "fixture/unlinked-app" },
            installation: { id: 123456789 },
          },
          githubConnectionId: f.connectionId,
        })
        expect(await issueRuns(f)).toHaveLength(3)
      } finally {
        await stopAll(f, worker)
      }
    })
  },
)

it(
  "skips the issues when the installation has not accepted the Issues permission",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(fixtureOptions, async (f) => {
      const requests = serveIssues(f, new Map([[3, graphqlIssue(3)]]))
      // GitHub refuses a credential with a permission the owner did not accept.
      f.server.use(
        http.post(
          "https://api.github.com/app/installations/123456789/access_tokens",
          async ({ request }) => {
            const body = (await request.clone().json()) as {
              permissions?: Record<string, string>
            }
            if (!body.permissions?.issues) return undefined
            return HttpResponse.json(
              {
                message:
                  "The permissions requested are not granted to this installation.",
              },
              { status: 422 },
            )
          },
        ),
      )
      const worker = await startWorker(f)
      try {
        const [backfill] = await settledIssueRuns(f, 1)
        expect(backfill).toMatchObject({
          status: "completed",
          output: { written: 0, skipped: "no_issues_permission" },
        })
        expect(requests).toHaveLength(0)
        expect(filesIn(f)).not.toContain(issuePath(3))
      } finally {
        await stopAll(f, worker)
      }
    })
  },
)
