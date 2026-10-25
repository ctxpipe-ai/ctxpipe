import { sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { cleanupSeededOrg, seedOrg } from "../../../test/db.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, initDb } from "../../db/client.js"
import { members } from "../../db/schema/auth.js"
import { getWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceUpgradeRoutes } from "../../routes/v1/workspace-upgrades-routes.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { readIngestSkillBundle } from "../ingestion/skill-bundle.js"
import {
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
} from "../workspaces/workspace-format.js"
import { AUTOMATIC_UPGRADE_APPROVER, setUpgradeMode } from "./automatic.js"
import {
  GIT_UPGRADE_STEPS,
  type GitUpgradeStep,
  upgradeBranch,
  upgradeRelease,
} from "./registry.js"

/** Test steps: only step 3 changes a file. */
const STEPS: GitUpgradeStep[] = [1, 2].map((format) => ({
  format,
  title: `Step ${format}`,
  description: "A test step.",
  plan: async () => ({ writes: [], deletes: [], report: [] }),
}))
STEPS.push({
  format: 3,
  title: "Add notes",
  description: "A test step.",
  plan: async () => ({
    writes: [{ path: "notes/a.md", content: "A\n" }],
    deletes: [],
    report: ["Added notes/a.md"],
  }),
})

const KEY = "format-3"
const BRANCH = upgradeBranch(3)
const PULLS = "https://api.github.com/repos/fixture/hydration-contract/pulls"

it(
  "Always update commits the setting to the format file, and the scan that the write queues starts the upgrade with no click",
  { timeout: 150_000 },
  async () => {
    let openPulls: unknown[] = []
    // The route checks a real session role, so an owner session of another
    // org joins the fixture org for the request that saves the mode.
    const seed = await seedOrg()
    try {
      await withNativeHydrationFixture(
        {
          github: true,
          githubWriteView: "writable",
          writeStatus: "writable",
          format: 2,
          files: [{ path: "README.md", body: "# Readme\n" }],
          onGithubPullRequest: (body) => {
            const pull = body as { head: string }
            openPulls = [
              {
                number: 52,
                html_url:
                  "https://github.com/fixture/hydration-contract/pull/52",
                head: {
                  ref: pull.head,
                  repo: { full_name: "fixture/hydration-contract" },
                },
                user: { type: "Bot", login: "ctxpipe-fixture[bot]" },
                created_at: "2026-10-19T00:00:00Z",
              },
            ]
          },
        },
        async (f) => {
          await f.publish()
          f.server.use(
            http.get(PULLS, () => HttpResponse.json(openPulls)),
            http.get(`${PULLS}/:number`, () =>
              HttpResponse.json({ message: "Not found" }, { status: 404 }),
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
          const { workspaceFileEdit } = await import(
            "../../openworkflow/workflows/workspace-file-edit.js"
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
          runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
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
          const show = (ref: string, path: string) =>
            f.git("--git-dir", f.remote, "show", `${ref}:${path}`)
          // The settings toggle reads the setting from git at the head of the
          // default branch, so a saved setting shows at once.
          const readMode = async () => {
            const response = await workspaceHttpApp(
              f.org,
              workspaceUpgradeRoutes,
            ).request("/workspaces/knowledge/upgrades/automatic")
            expect(response.status).toBe(200)
            const body = (await response.json()) as {
              mode: string | null
              reason: string | null
            }
            expect(body.reason).toBeNull()
            return body.mode
          }
          const saveMode = async (mode: "manual" | "automatic") => {
            const jobId = `wjob_${f.id}_${mode}`
            expect(
              await withOrgIdContext(f.org, () =>
                setUpgradeMode(
                  {
                    jobId,
                    orgId: f.org.id,
                    workspace: { id: f.workspaceId },
                    mode,
                  },
                  {
                    error: (error) => {
                      throw error
                    },
                  },
                ),
              ),
            ).toEqual({ started: true })
            await expect
              .poll(
                async () =>
                  withOrgIdContext(
                    f.org,
                    async () =>
                      (await reconcileWorkspaceWriteJob(jobId))?.status,
                  ),
                { timeout: 30_000 },
              )
              .toBe("completed")
          }
          try {
            await worker.start()
            expect(await readMode()).toBe("manual")
            // Without the setting, the scan records the upgrade and starts nothing.
            expect(await runScan("manual")).toMatchObject({
              workspaces: [{ kind: "pending", key: KEY }],
              automatic: [],
            })
            expect((await row())?.status).toBe("awaiting_operator")

            // Always update: a commit on the default branch sets the setting
            // and keeps the format of the tree (the request names no format).
            await saveMode("automatic")
            const tip = f.git(
              "--git-dir",
              f.remote,
              "rev-parse",
              "refs/heads/main",
            )
            expect(tip).not.toBe(f.sha)
            expect(
              readWorkspaceFormat(show(tip, WORKSPACE_FORMAT_PATH)),
            ).toEqual({ kind: "format", format: 2, upgrades: "automatic" })

            // The write queued a scan, so the waiting upgrade starts with no
            // click and with no other request.
            await expect
              .poll(async () => (await row())?.status, { timeout: 60_000 })
              .toBe("pr_open")
            expect((await row())?.upgrade.approvedBy).toBe(
              AUTOMATIC_UPGRADE_APPROVER,
            )
            // The upgrade pull request starts from the setting commit and keeps
            // the setting in the new format file.
            expect(
              readWorkspaceFormat(
                show(`refs/heads/${BRANCH}`, WORKSPACE_FORMAT_PATH),
              ),
            ).toEqual({ kind: "format", format: 3, upgrades: "automatic" })
            expect(await readMode()).toBe("automatic")

            // Turn off: a second commit sets the setting back to manual, and
            // the read shows it as soon as the job is done.
            // The request goes through the HTTP route, so the mode in the body
            // must reach the job.
            await getSystemDb()
              .insert(members)
              .values({
                id: `mem_${f.id}`,
                organizationId: f.org.id,
                userId: seed.userId,
                role: "owner",
                createdAt: new Date(),
              })
            const response = await workspaceHttpApp(
              f.org,
              workspaceUpgradeRoutes,
            ).request("/workspaces/knowledge/upgrades/automatic", {
              method: "POST",
              headers: {
                "content-type": "Application/JSON",
                cookie: seed.cookie,
              },
              body: JSON.stringify({ mode: "manual" }),
            })
            expect(response.status).toBe(202)
            const { jobId } = (await response.json()) as { jobId: string }
            await expect
              .poll(
                async () =>
                  withOrgIdContext(
                    f.org,
                    async () =>
                      (await reconcileWorkspaceWriteJob(jobId))?.status,
                  ),
                { timeout: 30_000 },
              )
              .toBe("completed")
            expect(await readMode()).toBe("manual")
          } finally {
            await worker.stop()
            await backend.stop()
          }
        },
      )
    } finally {
      // The fixture closed the database pool.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  },
)

it(
  "a scan that cannot be queued after the setting commit does not change the file job",
  { timeout: 150_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        format: 2,
        files: [{ path: "README.md", body: "# Readme\n" }],
      },
      async (f) => {
        await f.publish()
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { workspaceFileEdit } = await import(
          "../../openworkflow/workflows/workspace-file-edit.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const jobId = `wjob_${f.id}_automatic`
        // A run of another version holds the key of the scan that the write
        // queues, so the enqueue is refused, as it is after a deploy.
        const release = upgradeRelease(
          GIT_UPGRADE_STEPS,
          (await readIngestSkillBundle()).name,
        )
        await getSystemDb().execute(sql`
          insert into openworkflow.workflow_runs
            (namespace_id, id, workflow_name, version, status, idempotency_key, config, input, attempts, created_at, updated_at)
          values (
            ${openWorkflowNamespaceId()}, ${`run_scan_${f.id}`}, 'workspace-upgrade-scan', 'another-version', 'completed',
            ${`upgrade-scan:${f.org.id}:${release}:setting:${jobId}`}, '{}'::jsonb, ${JSON.stringify({ orgId: f.org.id })}::jsonb, 1, now(), now())`)
        try {
          await worker.start()
          expect(
            await withOrgIdContext(f.org, () =>
              setUpgradeMode(
                {
                  jobId,
                  orgId: f.org.id,
                  workspace: { id: f.workspaceId },
                  mode: "automatic",
                },
                {
                  error: (error) => {
                    throw error
                  },
                },
              ),
            ),
          ).toEqual({ started: true })
          // The setting is saved and the job is done, although no scan queued.
          await expect
            .poll(
              async () =>
                withOrgIdContext(
                  f.org,
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 60_000 },
            )
            .toBe("completed")
          // The run of the write ends well too: the refused enqueue is logged.
          await expect
            .poll(
              async () =>
                (
                  await getSystemDb().execute<{ status: string }>(sql`
                    select status from openworkflow.workflow_runs
                    where namespace_id = ${openWorkflowNamespaceId()}
                      and workflow_name = 'workspace-write-ui-file-edit'
                      and input->>'jobId' = ${jobId}`)
                ).rows[0]?.status,
              { timeout: 60_000 },
            )
            .toBe("completed")
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          expect(
            readWorkspaceFormat(
              f.git(
                "--git-dir",
                f.remote,
                "show",
                `${tip}:${WORKSPACE_FORMAT_PATH}`,
              ),
            ),
          ).toEqual({ kind: "format", format: 2, upgrades: "automatic" })
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
