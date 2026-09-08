import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  resolveLinkedReadRevision,
  resolveWorkspaceReadRevision,
} from "../../domain/workspaces/resolve-revision.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import {
  chatSandboxesDueForDestroy,
  destroySandboxesForConversation,
  destroySandboxesForWorkspace,
  jobSandboxesDueForDestroy,
} from "../../domain/workspaces/sandbox-registry.js"
import { shouldEnqueueCronHydrate } from "../../domain/workspaces/tip-resolve.js"
import { resumePausedWriteJobs } from "../../domain/workspaces/write-job-resume.js"
import {
  nextPersistedWriteProbe,
  probeWorkspaceWriteAccess,
} from "../../domain/workspaces/write-status.js"
import { listOrgConversationsForSandboxGc } from "../../models/conversations.js"
import {
  claimPausedWriteJob,
  getWorkspaceProjection,
  listMigrationExportJobWorkspaceIds,
  listMigrationExportShas,
  listOrgLinkedRepositories,
  listOrgWorkspaces,
  listPausedWriteJobs,
  persistWriteStatus,
  reconcileDestWorkspaceAssignment,
} from "../../models/workspaces.js"
import { getGithubRepoWriteView } from "../../routes/webhooks/github/github-workspace-tip.js"
import { enqueueWorkspaceCommitProjection } from "../enqueue-workspace-commit-projection.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"
import {
  type EnqueueWorkspaceWriteCommitInput,
  enqueueWorkspaceWriteCommit,
} from "../enqueue-workspace-write-commit.js"

const workspaceTipCheckInputSchema = z.object({
  orgId: z.string().min(1),
})

export const workspaceTipCheck = defineWorkflow(
  { name: "workspace-tip-check", schema: workspaceTipCheckInputSchema },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)
    return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      await withOrgDbContext(input.orgId, () =>
        reconcileDestWorkspaceAssignment(input.orgId),
      )
      const workspaces = await withOrgDbContext(input.orgId, () =>
        listOrgWorkspaces(input.orgId),
      )
      const quietLog = { error: () => undefined }
      const writeStatusById = new Map<string, string>()
      const writeCommitsToEnqueue: EnqueueWorkspaceWriteCommitInput[] = []
      for (const workspace of workspaces) {
        const probe = await probeWorkspaceWriteAccess({
          workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
          githubConnectionId: workspace.githubConnectionId,
          orgId: input.orgId,
          fetchWriteView: (args) =>
            getGithubRepoWriteView({
              ...args,
              env,
            }),
        })
        const write = nextPersistedWriteProbe({
          currentStatus: workspace.writeStatus,
          probe,
        })
        const claimed = await withOrgDbContext(input.orgId, async () => {
          if (!(await persistWriteStatus(workspace, write, input.orgId)))
            return []
          writeStatusById.set(workspace.id, write.writeStatus)
          if (write.writeStatus !== "writable") return []
          const pending: EnqueueWorkspaceWriteCommitInput[] = []
          await resumePausedWriteJobs({
            orgId: input.orgId,
            workspaceId: workspace.id,
            writeStatus: probe.writeStatus,
            desiredGeneration: workspace.desiredGeneration,
            desiredWorkspaceUrl: workspace.workspaceRepositoryUrl,
            jobs: await listPausedWriteJobs(workspace.id),
            claim: claimPausedWriteJob,
            enqueue: async (args) => {
              pending.push(args)
              return { started: true }
            },
            log: quietLog,
          })
          return pending
        })
        writeCommitsToEnqueue.push(...claimed)
      }
      for (const args of writeCommitsToEnqueue) {
        await enqueueWorkspaceWriteCommit(args, quietLog)
      }
      const updated: Array<{
        workspaceId: string
        resolvedTip: string
        revision: WorkspaceRevision
      }> = []
      for (const workspace of workspaces) {
        const resolved = await resolveWorkspaceReadRevision({
          orgId: input.orgId,
          workspaceId: workspace.id,
          env,
          refresh: true,
        })
        if (
          resolved &&
          (resolved.revision.sha !== workspace.desiredSha ||
            resolved.revision.defaultBranch !== workspace.desiredDefaultBranch)
        )
          updated.push({
            workspaceId: workspace.id,
            resolvedTip: resolved.revision.sha,
            revision: resolved.revision,
          })
      }
      const [exportShas, exportJobWorkspaceIds] = await withOrgDbContext(
        input.orgId,
        () =>
          Promise.all([
            listMigrationExportShas(),
            listMigrationExportJobWorkspaceIds(),
          ]),
      )
      for (const workspace of workspaces) {
        const writeStatus = writeStatusById.get(workspace.id)
        if (
          writeStatus === "writable" &&
          !exportShas.has(workspace.id) &&
          !exportJobWorkspaceIds.has(workspace.id)
        ) {
          await enqueueWorkspaceWriteCommit(
            {
              orgId: input.orgId,
              workspaceId: workspace.id,
              kind: "migration_export",
            },
            quietLog,
          )
        }
        if (
          updated.some((item) => item.workspaceId === workspace.id) ||
          shouldEnqueueCronHydrate({
            migrationExportSha: exportShas.get(workspace.id) ?? null,
            projection: await getWorkspaceProjection(workspace.id),
            writeStatus: writeStatusById.get(workspace.id),
          })
        ) {
          await enqueueWorkspaceHydrate(
            { orgId: input.orgId, workspaceId: workspace.id },
            { error: () => undefined },
          )
        }
      }
      for (const item of updated) {
        const row = workspaces.find(
          (workspace) => workspace.id === item.workspaceId,
        )
        if (row) {
          await enqueueWorkspaceIndex(
            {
              orgId: input.orgId,
              revision: item.revision,
            },
            { error: () => undefined },
          )
          await enqueueWorkspaceCommitProjection(
            { orgId: input.orgId, workspaceId: row.id },
            { error: () => undefined },
          )
        }
      }
      const linked = await withOrgDbContext(input.orgId, () =>
        listOrgLinkedRepositories(input.orgId),
      )
      let linkedUpdated = 0
      for (const row of linked) {
        const resolved = await resolveLinkedReadRevision({
          orgId: input.orgId,
          linkId: row.id,
          env,
        })
        if (!resolved?.changed) continue
        linkedUpdated += 1
        await enqueueWorkspaceIndex(
          {
            orgId: input.orgId,
            revision: resolved.revision.owner,
            linked: resolved.revision,
          },
          quietLog,
        )
      }
      const now = new Date()
      const idleChats = chatSandboxesDueForDestroy({
        conversations: await withOrgDbContext(input.orgId, () =>
          listOrgConversationsForSandboxGc(input.orgId),
        ),
        now,
      })
      for (const conversationId of idleChats) {
        await destroySandboxesForConversation(conversationId)
      }
      const idleJobs = jobSandboxesDueForDestroy({
        workspaces: workspaces.map((row) => ({
          id: row.id,
          lastJobAt: row.lastJobAt,
        })),
        now,
      })
      for (const workspaceId of idleJobs) {
        await destroySandboxesForWorkspace(workspaceId, "job")
      }
      return { updated: updated.length, linkedUpdated }
    })
  },
)
