import { afterEach, expect, it, vi } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { ow } from "../openworkflow/client.js"
import { workspaceFileEdit } from "../openworkflow/workflows/workspace-file-edit.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import {
  persistBoundWriteJob,
  reconcileWorkspaceWriteJob,
  reconcileWriteJobAdmission,
} from "./workspace-write-jobs.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

it(
  "recovers a Railway preview-namespace write owner and still rejects the production default",
  { timeout: 20_000 },
  async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-280")
    await withNativeHydrationFixture(
      { namespaceId: "preview-pr-280", github: true },
      async (f) => {
        const revision = { ...f.revision, access: "write-default" as const }
        const files = [
          { path: "knowledge/preview.md", content: "# Preview owner\n" },
        ]
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_preview`,
          revision,
          files,
          deletePaths: [],
        }

        await withOrgIdContext(f.org, () =>
          persistBoundWriteJob({
            id: command.jobId,
            kind: "ui_file_edit",
            revision,
            files,
          }),
        )
        const foreign = await ow.runWorkflow(workspaceFileEdit.spec, command, {
          idempotencyKey: command.jobId,
        })
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWriteJobAdmission(command.jobId),
          ),
        ).toBe(false)
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(command.jobId),
          ),
        ).toMatchObject({
          status: "failed",
          payload: expect.not.objectContaining({
            workflowRunId: foreign.workflowRun.id,
          }),
        })

        const retryId = `wjob_${f.id}_preview_retry`
        const retry = { ...command, jobId: retryId }
        await withOrgIdContext(f.org, () =>
          persistBoundWriteJob({
            id: retryId,
            kind: "ui_file_edit",
            revision,
            files,
          }),
        )
        const owner = await f.runner.runWorkflow(
          workspaceFileEdit.spec,
          retry,
          { idempotencyKey: retryId },
        )
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWriteJobAdmission(retryId),
          ),
        ).toBe(true)
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(retryId),
          ),
        ).toMatchObject({
          status: "queued",
          payload: { workflowRunId: owner.workflowRun.id },
        })

        await owner.cancel()
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(retryId),
          ),
        ).toMatchObject({
          status: "failed",
          payload: { workflowRunId: owner.workflowRun.id },
        })

        await withOrgIdContext(f.org, () =>
          persistBoundWriteJob({
            id: `wjob_${f.id}_copied`,
            kind: "ui_file_edit",
            revision,
            files,
            workflowRunId: foreign.workflowRun.id,
          }),
        )
        await foreign.cancel()
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(`wjob_${f.id}_copied`),
          ),
        ).toMatchObject({
          status: "running",
          payload: { workflowRunId: foreign.workflowRun.id },
        })
      },
    )
  },
)
