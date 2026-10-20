import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import {
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
} from "../workspaces/workspace-format.js"
import {
  AUTOMATIC_UPGRADE_APPROVER,
  enableAutomaticUpgrades,
} from "./automatic.js"
import { type GitUpgradeStep, upgradeBranch } from "./registry.js"

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
  "Always update commits the setting to the format file, and the next scan starts the upgrade with no click",
  { timeout: 150_000 },
  async () => {
    let openPulls: unknown[] = []
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
              html_url: "https://github.com/fixture/hydration-contract/pull/52",
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
        try {
          await worker.start()
          // Without the setting, the scan records the upgrade and starts nothing.
          expect(await runScan("manual")).toMatchObject({
            workspaces: [{ kind: "pending", key: KEY }],
            automatic: [],
          })
          expect((await row())?.status).toBe("awaiting_operator")

          // Always update: a commit on the default branch sets the setting
          // and keeps the format.
          const jobId = `wjob_${f.id}_automatic`
          expect(
            await withOrgIdContext(f.org, () =>
              enableAutomaticUpgrades(
                {
                  jobId,
                  orgId: f.org.id,
                  workspace: { id: f.workspaceId, formatVersion: 2 },
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
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          expect(tip).not.toBe(f.sha)
          expect(readWorkspaceFormat(show(tip, WORKSPACE_FORMAT_PATH))).toEqual(
            { kind: "format", format: 2, upgrades: "automatic" },
          )

          // The next scan starts the waiting upgrade with no click.
          expect(await runScan("automatic")).toMatchObject({
            automatic: [{ workspaceId: f.workspaceId, kind: KEY }],
          })
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
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
