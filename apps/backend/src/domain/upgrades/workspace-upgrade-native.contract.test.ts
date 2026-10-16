import { writeFileSync } from "node:fs"
import { and, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import {
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { WORKSPACE_FORMAT_PATH } from "../workspaces/workspace-format.js"
import {
  type GitUpgradeStep,
  UPGRADE_JOB_KIND,
  upgradeBranch,
} from "./registry.js"
import { startWorkspaceUpgrade } from "./start.js"

/** Test steps: 1 adds a file, 2 changes nothing, 3 reads the file of step 1. */
const STEPS: GitUpgradeStep[] = [
  {
    format: 1,
    title: "Add notes",
    plan: async () => ({
      writes: [{ path: "notes/a.md", content: "A\n" }],
      deletes: [],
      report: ["Added notes/a.md"],
    }),
  },
  {
    format: 2,
    title: "Nothing to change",
    plan: async () => ({ writes: [], deletes: [], report: [] }),
  },
  {
    format: 3,
    title: "Move notes",
    plan: async (tree) => ({
      writes: [
        {
          path: "notes/b.md",
          content: `${(await tree.read("notes/a.md")) ?? ""}then B\n`,
        },
      ],
      deletes: ["old.md"],
      report: ["Moved the notes"],
    }),
  },
]

const KEY = "format-3"
const BRANCH = upgradeBranch(3)
const PULLS = "https://api.github.com/repos/fixture/hydration-contract/pulls"

it(
  "records an upgrade without starting it, opens one pull request per click, and makes the row again from git",
  { timeout: 150_000 },
  async () => {
    const opened: Array<{
      head: string
      base: string
      title: string
      body: string
    }> = []
    // Three pull requests of others on the upgrade branch name: one from a
    // fork, one in the repository from a person, and one in the repository
    // from another GitHub App. ctx| ignores all three: it does not record
    // them, it does not change their text (the fixture refuses a pull
    // request update), and it opens its own pull request.
    const foreignPulls = [
      {
        number: 7,
        html_url: "https://github.com/fixture/hydration-contract/pull/7",
        head: {
          ref: BRANCH,
          repo: { full_name: "someone/hydration-contract" },
        },
        user: { type: "Bot", login: "ctxpipe-fixture[bot]" },
        created_at: "2026-10-15T00:00:00Z",
      },
      {
        number: 8,
        html_url: "https://github.com/fixture/hydration-contract/pull/8",
        head: {
          ref: BRANCH,
          repo: { full_name: "fixture/hydration-contract" },
        },
        user: { type: "User", login: "someone" },
        created_at: "2026-10-15T00:00:00Z",
      },
      {
        number: 9,
        html_url: "https://github.com/fixture/hydration-contract/pull/9",
        head: {
          ref: BRANCH,
          repo: { full_name: "fixture/hydration-contract" },
        },
        user: { type: "Bot", login: "other-app[bot]" },
        created_at: "2026-10-15T00:00:00Z",
      },
    ]
    let openPulls: Array<(typeof foreignPulls)[number]> = foreignPulls
    let closedPull: Record<string, unknown> | null = null
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "README.md", body: "# Readme\n" },
          { path: "old.md", body: "Old\n" },
        ],
        onGithubPullRequest: (body) => {
          const pull = body as (typeof opened)[number]
          opened.push(pull)
          openPulls = [
            ...foreignPulls,
            {
              number: 41,
              html_url: "https://github.com/fixture/hydration-contract/pull/41",
              head: {
                ref: pull.head,
                repo: { full_name: "fixture/hydration-contract" },
              },
              user: { type: "Bot", login: "ctxpipe-fixture[bot]" },
              created_at: "2026-10-16T00:00:00Z",
            },
          ]
        },
      },
      async (f) => {
        f.server.use(
          http.get(PULLS, () => HttpResponse.json(openPulls)),
          http.get(`${PULLS}/:number`, () =>
            closedPull
              ? HttpResponse.json(closedPull)
              : HttpResponse.json({ message: "Not found" }, { status: 404 }),
          ),
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { defineWorkspaceUpgradeScan } = await import(
          "../../openworkflow/workflows/workspace-upgrade-scan.js"
        )
        const { defineWorkspaceUpgrade } = await import(
          "../../openworkflow/workflows/workspace-upgrade.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        const scan = defineWorkspaceUpgradeScan(STEPS)
        const upgrade = defineWorkspaceUpgrade(STEPS)
        runner.implementWorkflow(scan.spec, scan.fn)
        runner.implementWorkflow(upgrade.spec, upgrade.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const runScan = async (trigger: string) => {
          const handle = await runner.runWorkflow(scan.spec, {
            orgId: f.org.id,
            release: "test",
            trigger,
          })
          return handle.result({ timeoutMs: 30_000 })
        }
        const row = () =>
          withOrgIdContext(f.org, () =>
            getWorkspaceUpgradeRow(f.workspaceId, KEY),
          )
        const start = () =>
          withOrgIdContext(f.org, () =>
            startWorkspaceUpgrade({
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              key: KEY,
              userId: "user_admin",
            }),
          )
        const upgradeRuns = async () =>
          (await backend.listWorkflowRuns({ limit: 200 })).data.filter(
            (run) =>
              run.workflowName === "workspace-upgrade" &&
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId,
          )
        const branchLog = () =>
          f
            .git(
              "--git-dir",
              f.remote,
              "log",
              "--format=%s",
              `refs/heads/${BRANCH}`,
            )
            .split("\n")
        try {
          await worker.start()
          // No hydrate ran, so the format cache is null: the scan reads the
          // file from git (no file is format 0).
          expect(await runScan("first")).toMatchObject({
            workspaces: [
              {
                workspaceId: f.workspaceId,
                kind: "pending",
                key: KEY,
                status: "awaiting_operator",
              },
            ],
          })
          expect(await row()).toMatchObject({
            status: "awaiting_operator",
            upgrade: { fromFormat: 0, targetFormat: 3, branch: BRANCH },
          })
          // The scan starts nothing: no run, no branch, no pull request.
          expect(await upgradeRuns()).toEqual([])
          expect(() =>
            f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${BRANCH}`),
          ).toThrow()
          expect(opened).toEqual([])
          // It queues the tip check that resumes held write jobs.
          expect(
            (await backend.listWorkflowRuns({ limit: 200 })).data.some(
              (run) =>
                run.idempotencyKey ===
                `upgrade-scan-tip:${f.org.id}:test:first`,
            ),
          ).toBe(true)

          // The click of an owner or admin.
          expect(await start()).toMatchObject({ kind: "queued" })
          await expect
            .poll(async () => (await row())?.status, { timeout: 60_000 })
            .toBe("pr_open")
          expect(await row()).toMatchObject({
            upgrade: {
              approvedBy: "user_admin",
              prNumber: 41,
              prUrl: "https://github.com/fixture/hydration-contract/pull/41",
              steps: [
                { format: 1, report: ["Added notes/a.md"] },
                { format: 2, sha: null },
                { format: 3, report: ["Moved the notes"] },
              ],
            },
          })
          // One commit for each step that changes a file, in order; the
          // format file comes last. The default branch does not change.
          expect(branchLog()).toEqual([
            "ctx| upgrade: set the Workspace format to 3",
            "ctx| upgrade to format 3: Move notes",
            "ctx| upgrade to format 1: Add notes",
            "Immutable fixture",
          ])
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              `refs/heads/${BRANCH}:notes/b.md`,
            ),
          ).toBe("A\nthen B")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              `refs/heads/${BRANCH}:${WORKSPACE_FORMAT_PATH}`,
            ),
          ).toContain("format: 3")
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
          expect(opened).toHaveLength(1)
          expect(opened[0]).toMatchObject({ head: BRANCH, base: "main" })
          expect(opened[0]?.body).toContain(
            "### Format 1: Add notes\n- Added notes/a.md",
          )
          expect(opened[0]?.body).toContain(
            "### Format 3: Move notes\n- Moved the notes",
          )

          // A second click opens no second pull request.
          expect(await start()).toMatchObject({
            kind: "existing",
            row: { status: "pr_open" },
          })
          expect(await upgradeRuns()).toHaveLength(1)
          expect(opened).toHaveLength(1)

          // A database without the rows gets them again from git.
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(workspaceWriteJobs)
              .where(
                and(
                  eq(workspaceWriteJobs.workspaceId, f.workspaceId),
                  eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
                ),
              ),
          )
          await runScan("after-wipe")
          expect(await row()).toMatchObject({
            status: "pr_open",
            upgrade: {
              prNumber: 41,
              prUrl: "https://github.com/fixture/hydration-contract/pull/41",
            },
          })

          // A pull request that closes without a merge waits for a new click.
          openPulls = []
          closedPull = {
            number: 41,
            state: "closed",
            merged_at: null,
            html_url: "https://github.com/fixture/hydration-contract/pull/41",
            head: { ref: BRANCH, sha: "a".repeat(40) },
          }
          await runScan("after-close")
          const waiting = await row()
          expect(waiting?.status).toBe("awaiting_operator")
          expect(waiting?.upgrade.note).toContain("closed without a merge")
          expect(waiting?.upgrade.prUrl).toBeUndefined()
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "completes the upgrade when hydrate reads the merged format, and queues the tip check that resumes held writes",
  { timeout: 150_000 },
  async () =>
    withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "README.md", body: "# Readme\n" },
          { path: WORKSPACE_FORMAT_PATH, body: "format: 2\n" },
        ],
      },
      async (f) => {
        f.server.use(http.get(PULLS, () => HttpResponse.json([])))
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { defineWorkspaceUpgradeScan } = await import(
          "../../openworkflow/workflows/workspace-upgrade-scan.js"
        )
        const { workspaceHydrate } = await import(
          "../../openworkflow/workflows/workspace-hydrate.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        const scan = defineWorkspaceUpgradeScan(STEPS)
        runner.implementWorkflow(scan.spec, scan.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await f.worker.start()
          expect(await f.handle.result({ timeoutMs: 30_000 })).toMatchObject({
            hydrated: true,
          })
          await worker.start()
          const row = () =>
            withOrgIdContext(f.org, () =>
              getWorkspaceUpgradeRow(f.workspaceId, KEY),
            )
          // The first hydrate read format 2 (the cache was null). Its scan
          // records the pending upgrade to format 3.
          await expect
            .poll(async () => (await row())?.status, { timeout: 30_000 })
            .toBe("awaiting_operator")
          expect((await row())?.upgrade.fromFormat).toBe(2)

          // The upgrade pull request merges: the default branch gets format 3.
          const clone = `${f.directory}/merge`
          f.git("clone", "-q", f.remote, clone)
          const inClone = (...args: string[]) =>
            f.git(
              "-C",
              clone,
              "-c",
              "user.name=test",
              "-c",
              "user.email=test@example.com",
              ...args,
            )
          writeFileSync(`${clone}/${WORKSPACE_FORMAT_PATH}`, "format: 3\n")
          inClone("commit", "-qam", "Merge the upgrade")
          inClone("push", "-q", "origin", "HEAD:main")
          const merged = inClone("rev-parse", "HEAD")
          const revision = await f.resolveRevision(true)
          expect(revision.sha).toBe(merged)
          const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision,
          })
          expect(await hydrate.result({ timeoutMs: 30_000 })).toMatchObject({
            hydrated: true,
          })
          await expect
            .poll(async () => (await row())?.status, { timeout: 30_000 })
            .toBe("completed")
          // The scan of the format change queues one tip check. The tip
          // check resumes the write jobs that the format gate held. The scan
          // queues it in a step after the row changes, so wait for it.
          await expect
            .poll(
              async () =>
                (await backend.listWorkflowRuns({ limit: 200 })).data
                  .map((run) => run.idempotencyKey)
                  .filter(
                    (key) =>
                      key?.startsWith(`upgrade-scan-tip:${f.org.id}:`) &&
                      key.endsWith(`:format:${f.workspaceId}:${merged}`),
                  ),
              { timeout: 30_000 },
            )
            .toHaveLength(1)
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    ),
)

it(
  "fails a row whose run stopped, so that the next click starts a new run",
  { timeout: 150_000 },
  async () =>
    withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "README.md", body: "# Readme\n" }],
      },
      async (f) => {
        f.server.use(http.get(PULLS, () => HttpResponse.json([])))
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { defineWorkspaceUpgradeScan } = await import(
          "../../openworkflow/workflows/workspace-upgrade-scan.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        const scan = defineWorkspaceUpgradeScan(STEPS)
        runner.implementWorkflow(scan.spec, scan.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const inOrg = <T>(fn: () => Promise<T>) => withOrgIdContext(f.org, fn)
        const start = () =>
          inOrg(() =>
            startWorkspaceUpgrade({
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              key: KEY,
              userId: "user_admin",
            }),
          )
        const upgradeRuns = async () =>
          (await backend.listWorkflowRuns({ limit: 200 })).data.filter(
            (run) =>
              run.workflowName === "workspace-upgrade" &&
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId,
          )
        try {
          await worker.start()
          const handle = await runner.runWorkflow(scan.spec, {
            orgId: f.org.id,
            release: "test",
            trigger: "first",
          })
          await handle.result({ timeoutMs: 30_000 })
          // No worker runs the upgrade, so each run stays where the test
          // puts it.
          await worker.stop()

          // A queued run that ends before it claims the row.
          expect(await start()).toMatchObject({ kind: "queued" })
          const [first] = await upgradeRuns()
          if (!first) throw new Error("expected an upgrade run")
          await runner.cancelWorkflowRun(first.id)
          expect(await start()).toMatchObject({
            kind: "queued",
            row: { status: "queued" },
          })
          expect(await upgradeRuns()).toHaveLength(2)

          // A run that claimed the row, and then ended without a result.
          const second = (await upgradeRuns()).find(
            (run) => run.id !== first.id,
          )
          if (!second) throw new Error("expected a second upgrade run")
          await inOrg(() =>
            transitionWorkspaceUpgradeRow({
              workspaceId: f.workspaceId,
              key: KEY,
              from: ["queued"],
              to: "running",
              workflowRunId: second.id,
            }),
          )
          await runner.cancelWorkflowRun(second.id)
          expect(await start()).toMatchObject({ kind: "queued" })
          expect(await upgradeRuns()).toHaveLength(3)
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    ),
)
