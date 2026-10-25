import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { OpenWorkflow } from "openworkflow"
import { Pool } from "pg"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { ownerUrlForMigrate } from "../../db/owner-migrate-url.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { listOrgLinkedRepositories } from "../../models/workspaces.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { githubSyncPullRequest } from "../../openworkflow/workflows/github-sync-pull-request.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { maybeEnqueueGithubPrMirror } from "../../routes/webhooks/github/github-pr-mirror-events.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { cancelWorkflowRunIfOpen } from "../../test/open-workflow-runs.js"
import { linkGithubSourceFile } from "../workspace-sources/github-links.js"

const SOURCE_URL = "https://github.com/fixture/source-app"
const SECOND_URL = "https://github.com/fixture/second-workspace.git"
// The fixture puts its GitHub connection id in place of `{{connectionId}}`.
const SOURCES =
  'version: 1\nsources:\n  - id: linked-repositories\n    provider: github\n    connection: "{{connectionId}}"\n    repositories: [fixture/source-app]\n'
const FILES = [
  { path: ".ctxpipe/sources.yaml", body: SOURCES },
  { path: "knowledge/owner.md", body: "# Owner text\n" },
]
const pullPath = (number: number) =>
  `github/pulls/fixture/source-app/${number}--${number * 10}.md`

function connection<T>(nodes: T[]) {
  return { pageInfo: { hasNextPage: false }, nodes }
}

/** A merged pull request as one GraphQL page returns it, relations inline. */
function graphqlPull(number: number, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

type GraphqlRequest = { query: string; variables: Record<string, unknown> }

/** GitHub GraphQL for the source repository; records every request. */
function serveSourceGraphql(
  f: NativeHydrationFixture,
  input: {
    merged: number[]
    /** Pull requests closed without a merge. */
    unmerged?: number[]
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
      if (body.query.includes("ClosedPullRequests")) {
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
                nodes: input.merged
                  .slice(start, end)
                  .map((number) => graphqlPull(number)),
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
            numbers.map((number) => [
              `pr${number}`,
              graphqlPull(
                number,
                input.unmerged?.includes(number)
                  ? { state: "CLOSED", merged: false, mergedAt: null }
                  : {},
              ),
            ]),
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
      state: "closed",
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
        namespaceId: openWorkflowNamespaceId(),
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
        runner.implementWorkflow(workspaceTipCheck.spec, workspaceTipCheck.fn)
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
        // A person merges a pull request that adds or removes the source file
        // of the repository: a commit on the remote of B, then a hydrate.
        const writeLink = async (action: "link" | "unlink") => {
          // The mirror commits to the remote too, so start from its tip.
          gitB("fetch", "--quiet", remoteB, "main")
          gitB("reset", "--hard", "--quiet", "FETCH_HEAD")
          const linked = linkGithubSourceFile({
            files: [],
            connectionId: f.connectionId,
            repository: { name: "fixture/source-app", ref: null },
          })
          for (const file of linked?.writes ?? []) {
            const path = join(sourceB, file.path)
            if (action === "link") {
              mkdirSync(dirname(path), { recursive: true })
              writeFileSync(path, file.content)
            } else gitB("rm", "-q", file.path)
          }
          gitB("add", ".")
          gitB(
            "-c",
            "user.name=Contract",
            "-c",
            "user.email=contract@example.test",
            "commit",
            "-m",
            `${action} source`,
          )
          gitB("push", remoteB, "main")
          await withOrgIdContext(f.org, () =>
            enqueueWorkspaceTipCheck(f.org.id, {
              error: (error) => {
                throw error
              },
            }),
          )
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

          // Linking B: its hydrate records the link and backfills B. The
          // access check of the projection reads the repository from GitHub
          // before it writes the source row of B. At that point no backfill
          // of B can exist: a backfill that runs before the row writes its
          // files without the sources stamp (CTX-854).
          // Each entry holds the backfills of B at one read before the row exists.
          const backfillsBeforeRow: string[][] = []
          let probe = true
          f.server.use(
            http.get(
              "https://api.github.com/repos/fixture/source-app",
              async () => {
                if (!probe || (await linkedTo(workspaceB)).length) return
                backfillsBeforeRow.push(
                  (await mirrorRuns())
                    .filter(
                      (run) =>
                        (run.input as { workspaceId: string }).workspaceId ===
                        workspaceB,
                    )
                    .map((run) => run.id),
                )
              },
            ),
          )
          await writeLink("link")
          await expect
            .poll(() => linkedTo(workspaceB), { timeout: 60_000 })
            .toEqual([SOURCE_URL])
          probe = false
          expect(backfillsBeforeRow.length).toBeGreaterThan(0)
          expect(backfillsBeforeRow.flat()).toEqual([])
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
          await writeLink("unlink")
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
              await cancelWorkflowRunIfOpen(f.backend, run.id)
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
        namespaceId: openWorkflowNamespaceId(),
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
              await cancelWorkflowRunIfOpen(f.backend, run.id)
          }
          await worker.stop()
        }
      },
    )
  },
)

it(
  "mirrors a pull request closed without a merge on the merged path and skips an open one",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        namespaceId: openWorkflowNamespaceId(),
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: FILES,
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const requests = serveSourceGraphql(f, {
          merged: [],
          unmerged: [11],
          pageSize: 20,
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
        const sync = (number: number, state: "open" | "closed") =>
          runner.runWorkflow(githubSyncPullRequest.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            gitUrl: SOURCE_URL,
            numbers: [number],
            candidate: {
              state,
              draft: false,
              updatedAt: "2026-03-11T00:00:00Z",
            },
          })
        try {
          await worker.start()
          await expect(
            (await sync(12, "open")).result({ timeoutMs: 60_000 }),
          ).resolves.toEqual({ written: 0, skipped: "policy" })
          expect(requests).toHaveLength(0)

          await expect(
            (await sync(11, "closed")).result({ timeoutMs: 60_000 }),
          ).resolves.toEqual({ written: 1 })
          expect(filesIn(f, f.remote)).toContain(pullPath(11))
          const mirrored = f.git(
            "--git-dir",
            f.remote,
            "show",
            `refs/heads/main:${pullPath(11)}`,
          )
          expect(mirrored).toContain("state: closed")
          expect(mirrored).toContain("merged: false")
          expect(mirrored).toContain("mergedAt: null")
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 200 }))
            .data) {
            if (!["completed", "failed", "canceled"].includes(run.status))
              await cancelWorkflowRunIfOpen(f.backend, run.id)
          }
          await worker.stop()
        }
      },
    )
  },
)

/**
 * Makes Postgres refuse the first `failures` inserts into a table, for rows
 * that match `condition` (SQL on `new`). A sequence is not transactional, so a
 * retry passes after that. `lift` removes the fault and closes the pool.
 */
async function refuseInserts(
  f: NativeHydrationFixture,
  input: { table: string; condition: string; failures: number },
) {
  const owner = new Pool({
    connectionString: ownerUrlForMigrate(f.databaseUrl),
  })
  const fault = `ctx854_fault_${f.id.replace(/[^a-z0-9]/gi, "_")}`
  await owner.query(`
    create sequence public.${fault}_seq;
    create function public.${fault}() returns trigger
    language plpgsql as $$
    begin
      if ${input.condition} then
        if nextval('public.${fault}_seq') <= ${input.failures} then
          raise exception 'The fixture refuses this insert';
        end if;
      end if;
      return new;
    end $$;
    create trigger ${fault} before insert on ${input.table}
      for each row execute function public.${fault}();
  `)
  let lifted = false
  return {
    owner,
    lift: async () => {
      if (lifted) return
      lifted = true
      await owner.query(`
        drop trigger ${fault} on ${input.table};
        drop function public.${fault}();
        drop sequence public.${fault}_seq;
      `)
      await owner.end()
    },
  }
}

const backfillRunsOf = async (f: NativeHydrationFixture) =>
  (await f.backend.listWorkflowRuns({ limit: 200 })).data.filter(
    (run) =>
      run.workflowName === "github-sync-pull-request" &&
      (run.input as { workspaceId?: string }).workspaceId === f.workspaceId,
  )

const hydrateSteps = async (f: NativeHydrationFixture) =>
  (
    await f.backend.listStepAttempts({
      workflowRunId: f.handle.workflowRun.id,
      limit: 1000,
    })
  ).data

const backfillFixture = {
  namespaceId: openWorkflowNamespaceId(),
  github: true,
  githubWriteView: "writable",
  writeStatus: "writable",
  files: FILES,
} as const

it(
  "enqueues the backfill of a new link when hydrate retries after it records the source row",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(backfillFixture, async (f) => {
      serveSourceGraphql(f, { merged: [7], pageSize: 20 })
      // The projection wrote the source row, so the retry sees the link as
      // known. Only the memoized output still names it.
      const fault = await refuseInserts(f, {
        table: "openworkflow.workflow_runs",
        condition: `new.workflow_name = 'github-sync-pull-request'
          and new.input->>'workspaceId' = '${f.workspaceId}'`,
        failures: 1,
      })
      try {
        await f.worker.start()
        await f.handle.result({ timeoutMs: 60_000 })
      } finally {
        await fault.lift()
      }
      expect(
        (await hydrateSteps(f))
          .filter((step) => step.status === "failed")
          .map((step) => step.stepName),
      ).toEqual(["enqueue-github-pr-backfills"])
      const backfills = await backfillRunsOf(f)
      try {
        expect(backfills.map((run) => run.input)).toEqual([
          { orgId: f.org.id, workspaceId: f.workspaceId, gitUrl: SOURCE_URL },
        ])
      } finally {
        for (const run of backfills)
          await cancelWorkflowRunIfOpen(f.backend, run.id)
      }
    })
  },
)

it(
  "projects the sources again and then enqueues the backfill when the first projection fails after the revision is active (CTX-854)",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(backfillFixture, async (f) => {
      serveSourceGraphql(f, { merged: [7], pageSize: 20 })
      // The commit makes the revision active before the projection. A retry
      // must still project, so that the row exists before the backfill runs.
      const fault = await refuseInserts(f, {
        table: "public.workspace_sources",
        condition: `new.workspace_id = '${f.workspaceId}'`,
        failures: 1,
      })
      try {
        await f.worker.start()
        await f.handle.result({ timeoutMs: 60_000 })
      } finally {
        await fault.lift()
      }
      expect(
        (await hydrateSteps(f))
          .filter((step) => step.status === "failed")
          .map((step) => step.stepName),
      ).toEqual(["project-workspace-sources"])
      const backfills = await backfillRunsOf(f)
      try {
        const rows = await listWorkspaceSourceRows({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
        })
        expect(rows.map((row) => row.sourceKey)).toHaveLength(1)
        expect(backfills.map((run) => run.input)).toEqual([
          { orgId: f.org.id, workspaceId: f.workspaceId, gitUrl: SOURCE_URL },
        ])
        // The backfill exists only after the row it reads.
        expect(backfills[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
          rows[0]?.createdAt.getTime() ?? Number.POSITIVE_INFINITY,
        )
      } finally {
        for (const run of backfills)
          await cancelWorkflowRunIfOpen(f.backend, run.id)
      }
    })
  },
)

it(
  "enqueues the backfill of a new link when the retry ends early because the desired SHA moved (CTX-854)",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(backfillFixture, async (f) => {
      serveSourceGraphql(f, { merged: [7], pageSize: 20 })
      // The enqueue fails until the desired SHA moves. The retry then ends
      // with `cas_discarded` before it reaches the enqueue step. A later
      // hydrate sees the link as known, so only the retry can enqueue it.
      const fault = await refuseInserts(f, {
        table: "openworkflow.workflow_runs",
        condition: `new.workflow_name = 'github-sync-pull-request'
          and new.input->>'workspaceId' = '${f.workspaceId}'`,
        failures: 1_000_000,
      })
      try {
        await f.worker.start()
        await expect
          .poll(
            async () =>
              (await hydrateSteps(f)).some(
                (step) =>
                  step.stepName === "enqueue-github-pr-backfills" &&
                  step.status === "failed",
              ),
            { timeout: 60_000, interval: 100 },
          )
          .toBe(true)
        await fault.owner.query(
          "update public.workspaces set desired_sha = $1 where id = $2",
          ["c".repeat(40), f.workspaceId],
        )
      } finally {
        await fault.lift()
      }
      await expect(f.handle.result({ timeoutMs: 60_000 })).resolves.toEqual({
        hydrated: false,
        reason: "cas_discarded",
      })
      const backfills = await backfillRunsOf(f)
      try {
        expect(backfills.map((run) => run.input)).toEqual([
          { orgId: f.org.id, workspaceId: f.workspaceId, gitUrl: SOURCE_URL },
        ])
      } finally {
        for (const run of backfills)
          await cancelWorkflowRunIfOpen(f.backend, run.id)
      }
    })
  },
)
