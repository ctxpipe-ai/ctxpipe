import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../models/workspace-write-jobs.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import { withLostNativeWorkflowInsertAck } from "../test/native-workflow-ack-loss.js"
import { enqueueWriteJob } from "./enqueue-workspace-write-commit.js"
import { workspaceFileEdit } from "./workflows/workspace-file-edit.js"

it.each([
  { mode: "returned-row" as const, outcome: "commit" },
  { mode: "disconnect" as const, outcome: "commit" },
  { mode: "returned-row" as const, outcome: "cancel" },
  { mode: "disconnect" as const, outcome: "cancel" },
])(
  "projects native $mode acknowledgement loss through $outcome",
  { timeout: 60_000 },
  async ({ mode, outcome }) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const jobId = `wjob_${f.id}_ack`
        const result = await withLostNativeWorkflowInsertAck(
          f.databaseUrl,
          "workspace-write-ui-file-edit",
          async (databaseUrl) => {
            const output = await promisify(execFile)(
              "bun",
              [
                fileURLToPath(
                  new URL(
                    "../test/native-workflow-ack-client.ts",
                    import.meta.url,
                  ),
                ),
                f.org.id,
                f.workspaceId,
                jobId,
              ],
              {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                env: { ...process.env, DATABASE_URL: databaseUrl },
                timeout: mode === "disconnect" ? 10_000 : 20_000,
                maxBuffer: 1024 * 1024,
              },
            ).catch((error: unknown) => {
              if (mode !== "disconnect") throw error
              return null
            })
            return output ? JSON.parse(output.stdout) : null
          },
          mode,
        )
        expect(result.lostAcknowledgement).toBe(true)
        if (mode === "returned-row")
          expect(result.result).toEqual({ started: true })
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const retry = () =>
          withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "ui_file_edit",
                mergeFiles: [
                  {
                    path: "knowledge/accepted.md",
                    content: "# Accepted native command\n",
                  },
                ],
              },
              {
                error: (error) => {
                  throw error
                },
              },
            ),
          )
        try {
          if (outcome === "cancel") {
            const commands = (
              await backend.listWorkflowRuns({ limit: 100 })
            ).data.filter(
              (run) => (run.input as { jobId?: string })?.jobId === jobId,
            )
            expect(commands).toHaveLength(1)
            const owner = commands[0]
            if (!owner) throw new Error("Accepted native owner missing")
            await runner.cancelWorkflowRun(owner.id)
            expect(
              await withOrgIdContext(f.org, () =>
                reconcileWorkspaceWriteJob(jobId),
              ),
            ).toMatchObject({ status: "failed" })
            expect(
              f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
            ).toBe(f.sha)
            return
          }
          expect(await retry()).toEqual({ started: true })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          expect(await retry()).toEqual({ started: true })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:knowledge/accepted.md",
            ),
          ).toBe("# Accepted native command")
          expect(
            (await backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) => (run.input as { jobId?: string })?.jobId === jobId,
            ),
          ).toHaveLength(1)
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
