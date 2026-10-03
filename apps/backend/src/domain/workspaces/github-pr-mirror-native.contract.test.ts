import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { OpenWorkflow } from "openworkflow"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { githubBackfillPullRequests } from "../../openworkflow/workflows/github-backfill-pull-requests.js"
import { githubSyncPullRequest } from "../../openworkflow/workflows/github-sync-pull-request.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { workspaceLinkUnlink } from "../../openworkflow/workflows/workspace-link-unlink.js"
import { maybeEnqueueGithubPrMirror } from "../../routes/webhooks/github/github-pr-mirror-events.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

const SOURCE_URL = "https://github.com/fixture/source-app"
const SOURCE_API = "https://api.github.com/repos/fixture/source-app"
const SECOND_URL = "https://github.com/fixture/second-workspace.git"
const DECLARATION = `---\ngit: ${JSON.stringify(SOURCE_URL)}\n---\n`

function pull(number: number) {
  return {
    number,
    id: number * 10,
    html_url: `${SOURCE_URL}/pull/${number}`,
    title: `Ship change ${number}`,
    body: "",
    state: "closed",
    merged: true,
    draft: false,
    user: { login: "alice", type: "User" },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { ref: `feature-${number}`, sha: "b".repeat(40) },
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: `2026-03-${String(number).padStart(2, "0")}T00:00:00.000Z`,
    merged_at: "2026-03-02T00:00:00.000Z",
  }
}

function mergedWebhook(number: number, repository = "fixture/source-app") {
  const { updated_at } = pull(number)
  return {
    action: "closed",
    pull_request: { number, merged: true, draft: false, updated_at },
    repository: { full_name: repository },
    installation: { id: 123456789 },
  }
}

it(
  "mirrors merged pull requests into every Workspace that links the repository",
  { timeout: 180_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        namespaceId: "default",
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "repositories/source-app.md", body: DECLARATION },
          { path: "knowledge/owner.md", body: "# Owner text\n" },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const pullReads = new Map<number, number>()
        f.server.use(
          http.get(`${SOURCE_API}/pulls`, () =>
            HttpResponse.json([
              { number: 7, merged_at: "2026-03-02T00:00:00.000Z" },
              { number: 6, merged_at: null },
            ]),
          ),
          http.get(`${SOURCE_API}/pulls/:number/files`, () =>
            HttpResponse.json([{ filename: "src/app.ts", status: "modified" }]),
          ),
          http.get(`${SOURCE_API}/pulls/:number/reviews`, () =>
            HttpResponse.json([]),
          ),
          http.get(`${SOURCE_API}/pulls/:number/comments`, () =>
            HttpResponse.json([]),
          ),
          http.get(`${SOURCE_API}/issues/:number/comments`, () =>
            HttpResponse.json([]),
          ),
          http.get(`${SOURCE_API}/pulls/:number`, ({ params }) => {
            const number = Number(params.number)
            pullReads.set(number, (pullReads.get(number) ?? 0) + 1)
            return HttpResponse.json(pull(number))
          }),
        )

        // Workspace A already links the source repository (tree + hydrate's table row).
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
        const filesIn = (remote: string) =>
          f.git(
            "--git-dir",
            remote,
            "ls-tree",
            "-r",
            "--name-only",
            "refs/heads/main",
          )
        const workspaceRepo = await withOrgIdContext(f.org, async () => {
          await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: SOURCE_URL,
            githubConnectionId: f.connectionId,
          })
          return ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          })
        })
        if (!workspaceRepo) throw new Error("Workspace repository missing")
        // Webhooks route by installation through the directory, as after install.
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select()
            .from(connections)
            .where(eq(connections.id, f.connectionId)),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        await withOrgDbContext(f.org.id, async (db) => {
          await db.insert(workspaces).values({
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
          })
          await db.insert(workspaceLinkedRepositories).values({
            id: `wlr_${f.id}_a`,
            orgId: f.org.id,
            workspaceId: workspaceA,
            gitUrl: SOURCE_URL,
          })
        })

        const runner = new OpenWorkflow({ backend: f.backend })
        runner.implementWorkflow(
          workspaceLinkUnlink.spec,
          workspaceLinkUnlink.fn,
        )
        runner.implementWorkflow(
          githubBackfillPullRequests.spec,
          githubBackfillPullRequests.fn,
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
        const runs = async (workflowName: string) =>
          (await f.backend.listWorkflowRuns({ limit: 200 })).data.filter(
            (run) =>
              run.workflowName === workflowName &&
              (run.input as { orgId?: string }).orgId === f.org.id,
          )
        const settled = async (workflowName: string, count: number) => {
          await expect
            .poll(
              async () =>
                (await runs(workflowName)).filter((run) =>
                  ["completed", "failed"].includes(run.status),
                ).length,
              { timeout: 45_000, interval: 250 },
            )
            .toBe(count)
          return runs(workflowName)
        }
        const writeJob = async (
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
              { timeout: 45_000, interval: 250 },
            )
            .toMatchObject({ status: "completed" })
        }
        try {
          await worker.start()

          // Linking B commits the declaration and backfills B from the link
          // workflow; A was linked before and gets no backfill.
          await writeJob(`wjob_${f.id}_link`, "link")
          const [backfill] = await settled("github-backfill-pull-requests", 1)
          expect(backfill).toMatchObject({
            status: "completed",
            input: { workspaceId: workspaceB, gitUrl: SOURCE_URL },
            output: { written: 1 },
          })
          expect(filesIn(remoteB)).toContain(
            "github/pulls/fixture/source-app/7--70.md",
          )
          expect(filesIn(f.remote)).not.toContain(
            "github/pulls/fixture/source-app/7--70.md",
          )
          // Hydrate projects B's new declaration into the linked table.
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(workspaceLinkedRepositories).values({
              id: `wlr_${f.id}_b`,
              orgId: f.org.id,
              workspaceId: workspaceB,
              gitUrl: SOURCE_URL,
            }),
          )

          // A replayed delivery is one mirror job per Workspace, not two.
          for (let delivery = 0; delivery < 2; delivery++)
            await maybeEnqueueGithubPrMirror({
              eventName: "pull_request",
              payload: mergedWebhook(8),
              githubConnectionId: f.connectionId,
            })
          const merged = await settled("github-sync-pull-request", 2)
          expect(
            merged
              .map((run) => (run.input as { workspaceId: string }).workspaceId)
              .sort(),
          ).toEqual([workspaceA, workspaceB].sort())
          for (const run of merged)
            expect(run).toMatchObject({
              status: "completed",
              output: {
                written: true,
                path: "github/pulls/fixture/source-app/8--80.md",
              },
            })
          expect(pullReads.get(8)).toBe(2)
          for (const remote of [f.remote, remoteB])
            expect(filesIn(remote)).toContain(
              "github/pulls/fixture/source-app/8--80.md",
            )
          expect(
            (await runs("repository-ingestion-orchestrator")).some(
              (run) =>
                (run.input as { repositoryId?: string }).repositoryId ===
                workspaceRepo.id,
            ),
          ).toBe(true)

          // A repository no Workspace links mirrors nowhere.
          await maybeEnqueueGithubPrMirror({
            eventName: "pull_request",
            payload: mergedWebhook(8, "fixture/unlinked-app"),
            githubConnectionId: f.connectionId,
          })
          expect(await runs("github-sync-pull-request")).toHaveLength(2)

          // Unlinking B removes its declaration; the table still lags (no
          // hydrate), yet git stops the mirror and earlier files stay.
          await writeJob(`wjob_${f.id}_unlink`, "unlink")
          expect(filesIn(remoteB)).not.toContain("repositories/source-app.md")
          await maybeEnqueueGithubPrMirror({
            eventName: "pull_request",
            payload: mergedWebhook(9),
            githubConnectionId: f.connectionId,
          })
          const afterUnlink = (await settled("github-sync-pull-request", 4))
            .filter((run) => (run.input as { number: number }).number === 9)
            .map((run) => [
              (run.input as { workspaceId: string }).workspaceId,
              run.output,
            ])
          expect(Object.fromEntries(afterUnlink)).toEqual({
            [workspaceA]: {
              written: true,
              path: "github/pulls/fixture/source-app/9--90.md",
            },
            [workspaceB]: { written: false, skipped: "unlinked" },
          })
          expect(filesIn(f.remote)).toContain(
            "github/pulls/fixture/source-app/9--90.md",
          )
          const filesB = filesIn(remoteB)
          expect(filesB).not.toContain(
            "github/pulls/fixture/source-app/9--90.md",
          )
          expect(filesB).toContain("github/pulls/fixture/source-app/7--70.md")
          expect(filesB).toContain("github/pulls/fixture/source-app/8--80.md")
          expect(await runs("github-backfill-pull-requests")).toHaveLength(1)

          // Once hydrate drops B's row, B gets no job at all.
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(workspaceLinkedRepositories)
              .where(
                and(
                  eq(workspaceLinkedRepositories.workspaceId, workspaceB),
                  eq(workspaceLinkedRepositories.gitUrl, SOURCE_URL),
                ),
              ),
          )
          await maybeEnqueueGithubPrMirror({
            eventName: "pull_request",
            payload: mergedWebhook(5),
            githubConnectionId: f.connectionId,
          })
          const last = (await settled("github-sync-pull-request", 5)).filter(
            (run) => (run.input as { number: number }).number === 5,
          )
          expect(last).toEqual([
            expect.objectContaining({
              input: expect.objectContaining({ workspaceId: workspaceA }),
            }),
          ])
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
