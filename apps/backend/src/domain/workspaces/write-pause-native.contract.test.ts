import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  listPausedWriteJobs,
  reconcileWorkspaceWriteJob,
} from "../../models/workspace-write-jobs.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { workspaceBootstrap } from "../../openworkflow/workflows/workspace-bootstrap.js"
import { workspaceFileEdit } from "../../openworkflow/workflows/workspace-file-edit.js"
import { workspaceSemanticMerge } from "../../openworkflow/workflows/workspace-semantic-merge.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"
import { enqueueInputFromPausedJob } from "./write-job-intent.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"

it(
  "resumes a paused captured command after a human advances the same repository",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, writeStatus: "writable" },
      async (f) => {
        await f.publish()
        const paused = await withOrgIdContext(f.org, () =>
          listPausedWriteJobs(f.workspaceId),
        )
        const job = paused.find((job) => job.kind === "bootstrap")
        if (!job) throw new Error("Expected paused bootstrap intent")
        writeFileSync(
          join(f.directory, "document-000.md"),
          "# Independent human edit\n",
        )
        f.git("add", "document-000.md")
        f.git("commit", "-m", "Human edit while write access is unavailable")
        f.git("push", f.remote, "HEAD:refs/heads/main")
        const resolved = await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        expect(resolved?.revision.sha).not.toBe(f.sha)
        f.repairWriteAccess()
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
        runner.implementWorkflow(
          workspaceSemanticMerge.spec,
          workspaceSemanticMerge.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        const errors: string[] = []
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                enqueueInputFromPausedJob({
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  job,
                }),
                {
                  error: (error) => {
                    errors.push(error.message)
                  },
                },
              ),
            ),
          ).toEqual({ started: true })
          expect(errors).toEqual([])
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () =>
                    (await reconcileWorkspaceWriteJob(job.id))?.status,
                ),
              { timeout: 45_000 },
            )
            .toBe("completed")
          expect(
            f.git("--git-dir", f.remote, "show", "main:document-000.md"),
          ).toBe("# Independent human edit")
          expect(
            f.git("--git-dir", f.remote, "show", "main:AGENTS.md"),
          ).toContain("name: Hydration contract")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("2")
        } finally {
          for (const run of (await backend.listWorkflowRuns({ limit: 100 }))
            .data) {
            if (
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId &&
              !["completed", "failed", "canceled"].includes(run.status)
            )
              await runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it.each(["bootstrap", "ui_file_edit"] as const)(
  "%s keeps its native owner while waiting for write access before acquisition",
  { timeout: 100_000 },
  async (kind) => {
    const { getWorkspaceById, persistWriteStatus } = await import(
      "../../models/workspaces.js"
    )
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
        runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_wait`,
          kind,
          ...(kind === "ui_file_edit"
            ? {
                mergeFiles: [
                  { path: "notes.md", content: "# Retained edit\n" },
                ],
                mergeDeletePaths: [],
              }
            : {}),
        }
        const log = {
          error: (error: Error) => {
            throw error
          },
        }
        try {
          expect(
            await withOrgIdContext(f.org, () => enqueueWriteJob(command, log)),
          ).toEqual({ started: true })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) => (run.input as { jobId?: string }).jobId === command.jobId,
          )
          if (!queued) throw new Error("Native write workflow was not admitted")
          expect(queued.workflowName).toBe(
            kind === "bootstrap"
              ? "workspace-write-bootstrap"
              : "workspace-write-ui-file-edit",
          )
          await withOrgIdContext(f.org, async () => {
            const binding = await getWorkspaceById(f.workspaceId)
            if (!binding) throw new Error("Fixture workspace missing")
            return persistWriteStatus(
              binding,
              {
                writeStatus: "read_only",
                readOnlyReason: "Fixture permission removed",
              },
              f.org.id,
            )
          })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () =>
                    (await reconcileWorkspaceWriteJob(command.jobId))?.status,
                ),
              { timeout: 15_000 },
            )
            .toBe("paused")
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
          expect(
            await withOrgIdContext(f.org, () => enqueueWriteJob(command, log)),
          ).toEqual({ started: true })
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () =>
                    (await reconcileWorkspaceWriteJob(command.jobId))?.status,
                ),
              { timeout: 75_000 },
            )
            .toBe("completed")
          const complete = await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(command.jobId),
          )
          expect(complete?.payload?.workflowRunId).toBe(queued.id)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
        } finally {
          for (const run of (await backend.listWorkflowRuns({ limit: 100 }))
            .data) {
            if (
              (run.input as { jobId?: string }).jobId === command.jobId &&
              run.error
            )
              console.info("Native wait failure", run.status, run.error.message)
            if (
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId &&
              !["completed", "failed", "canceled"].includes(run.status)
            )
              await runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "does not apply a permission probe from before a relink to the new binding",
  { timeout: 30_000 },
  async () => {
    const { getWorkspaceById, updateWorkspace } = await import(
      "../../models/workspaces.js"
    )
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        f.runner.implementWorkflow(
          workspaceBootstrap.spec,
          workspaceBootstrap.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        let relinked = false
        let newRun: Awaited<ReturnType<typeof f.runner.runWorkflow>> | undefined
        f.onWriteProbe(async () => {
          if (relinked) return
          relinked = true
          await withOrgIdContext(f.org, async () => {
            const original = await getWorkspaceById(f.workspaceId)
            if (!original) throw new Error("Fixture workspace missing")
            await updateWorkspace(original.slug, { githubConnectionId: null })
            await updateWorkspace(original.slug, {
              githubConnectionId: f.connectionId,
              write: {
                writeStatus: "read_only",
                readOnlyReason: "New binding requires access",
              },
            })
            const revision = await f.resolveRevision()
            newRun = await f.runner.runWorkflow(workspaceBootstrap.spec, {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_new_binding`,
              revision: { ...revision, access: "write-default" },
            })
          })
        })
        try {
          const errors: string[] = []
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId: `wjob_${f.id}_old_binding`,
                  kind: "bootstrap",
                },
                {
                  error: (error) => {
                    errors.push(error.message)
                  },
                },
              ),
            ),
          ).toEqual({ started: false })
          expect(
            await withOrgIdContext(f.org, () =>
              getWorkspaceById(f.workspaceId),
            ),
          ).toMatchObject({
            writeStatus: "read_only",
            readOnlyReason: "New binding requires access",
          })
          if (!newRun) throw new Error("New binding workflow missing")
          const nativeRunId = newRun.workflowRun.id
          await worker.start()
          await expect
            .poll(
              async () =>
                (
                  await f.backend.getWorkflowRun({
                    workflowRunId: nativeRunId,
                  })
                )?.status,
              { timeout: 15_000 },
            )
            .not.toBe("pending")
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          expect(
            f.tokenRequests.filter(
              (request) =>
                (request as { permissions?: { contents?: string } }).permissions
                  ?.contents === "write",
            ),
          ).toHaveLength(0)
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        } finally {
          if (newRun) await f.runner.cancelWorkflowRun(newRun.workflowRun.id)
          await worker.stop()
        }
      },
    )
  },
)

it(
  "retains one prepared commit and native owner through default-branch protection",
  { timeout: 100_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const hook = join(f.remote, "hooks/update")
        const rejected = join(f.remote, "rejected-candidate")
        writeFileSync(
          hook,
          '#!/bin/sh\nprintf "%s" "$3" > rejected-candidate\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n',
          { mode: 0o755 },
        )
        const jobId = `wjob_${f.id}_protected`
        const intent = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId,
          kind: "bootstrap" as const,
        }
        const log = {
          error: (error: Error) => {
            throw error
          },
        }
        expect(
          await withOrgIdContext(f.org, () => enqueueWriteJob(intent, log)),
        ).toEqual({ started: true })
        const handle = await runner.runWorkflow(
          workspaceBootstrap.spec,
          {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
          },
          { idempotencyKey: jobId },
        )
        try {
          await worker.start()
          await expect
            .poll(
              async () =>
                withOrgIdContext(
                  f.org,
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 20_000 },
            )
            .toBe("paused")
          const candidate = readFileSync(rejected, "utf8")
          expect(candidate).toMatch(/^[a-f0-9]{40}$/)
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
          const paused = await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          )
          expect(paused?.commitSha).toBe(candidate)
          expect(paused?.payload?.workflowRunId).toBe(handle.workflowRun.id)
          expect(
            await withOrgIdContext(f.org, () =>
              getWorkspaceById(f.workspaceId),
            ),
          ).toMatchObject({
            writeStatus: "read_only",
            readOnlyReason: WRITE_STATUS_REASONS.protectedBranch,
          })
          rmSync(hook)
          expect(
            await withOrgIdContext(f.org, () => enqueueWriteJob(intent, log)),
          ).toEqual({ started: true })
          expect(await handle.result({ timeoutMs: 75_000 })).toEqual({
            committed: true,
            commitSha: candidate,
          })
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
            candidate,
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
          const complete = await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          )
          expect(complete).toMatchObject({
            status: "completed",
            commitSha: candidate,
            payload: { workflowRunId: handle.workflowRun.id },
          })
          expect(f.semanticRequests).toEqual([])
        } finally {
          const finalRun = await backend.getWorkflowRun({
            workflowRunId: handle.workflowRun.id,
          })
          if (finalRun?.error)
            console.info(
              "Protected write native failure",
              finalRun.status,
              finalRun.error.message,
            )
          if (
            finalRun &&
            !["completed", "failed", "canceled"].includes(finalRun.status)
          )
            await runner.cancelWorkflowRun(handle.workflowRun.id)
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
