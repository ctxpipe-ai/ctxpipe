import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  chatSandboxesDueForDestroy,
  destroySandboxesForConversation,
  destroySandboxesForWorkspace,
  jobSandboxesDueForDestroy,
} from "../../domain/workspaces/sandbox-registry.js"
import {
  runCronLinkedTipChecks,
  runCronTipChecks,
  shouldEnqueueCronHydrate,
} from "../../domain/workspaces/tip-resolve.js"
import { resumePausedWriteJobs } from "../../domain/workspaces/write-job-resume.js"
import { probeWorkspaceWriteAccess } from "../../domain/workspaces/write-status.js"
import { listOrgConversationsForSandboxGc } from "../../models/conversations.js"
import {
  claimPausedWriteJob,
  getWorkspaceById,
  listMigrationExportShas,
  listOrgLinkedRepositories,
  listOrgWorkspaces,
  listPausedWriteJobs,
  persistLinkedDesiredSha,
  persistResolvedDesiredSha,
  persistWriteStatus,
} from "../../models/workspaces.js"
import {
  getGithubRepoWriteView,
  resolveWorkspaceRepositoryTip,
} from "../../routes/webhooks/github/github-workspace-tip.js"
import { enqueueWorkspaceCutover } from "../enqueue-workspace-cutover.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"
import { enqueueWorkspaceWriteCommit } from "../enqueue-workspace-write-commit.js"

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
    return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      withOrgDbContext(input.orgId, async () => {
        void enqueueWorkspaceCutover(input.orgId, { error: () => undefined })
        const workspaces = await listOrgWorkspaces(input.orgId)
        const quietLog = { error: () => undefined }
        for (const workspace of workspaces) {
          const probe = await probeWorkspaceWriteAccess({
            workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
            githubConnectionId: workspace.githubConnectionId,
            getRepo: (fullName) =>
              getGithubRepoWriteView({
                orgId: input.orgId,
                githubConnectionId: workspace.githubConnectionId,
                repoFullName: fullName,
                env,
              }),
          })
          await persistWriteStatus(workspace.id, probe)
          if (probe.writeStatus !== "writable") continue
          await resumePausedWriteJobs({
            orgId: input.orgId,
            workspaceId: workspace.id,
            writeStatus: probe.writeStatus,
            desiredGeneration: workspace.desiredGeneration,
            desiredWorkspaceUrl: workspace.workspaceRepositoryUrl,
            jobs: await listPausedWriteJobs(workspace.id),
            claim: claimPausedWriteJob,
            enqueue: enqueueWorkspaceWriteCommit,
            log: quietLog,
          })
        }
        const updated = await runCronTipChecks({
          workspaces,
          resolveTip: (workspaceRepositoryUrl) => {
            const row = workspaces.find(
              (item) => item.workspaceRepositoryUrl === workspaceRepositoryUrl,
            )
            return resolveWorkspaceRepositoryTip({
              orgId: input.orgId,
              githubConnectionId: row?.githubConnectionId,
              workspaceRepositoryUrl,
              env,
            })
          },
          persist: persistResolvedDesiredSha,
          reloadDesiredSha: async (workspaceId) =>
            (await getWorkspaceById(workspaceId))?.desiredSha ?? null,
        })
        const desiredById = new Map(
          workspaces.map((row) => [row.id, row.desiredSha]),
        )
        for (const item of updated) {
          desiredById.set(item.workspaceId, item.resolvedTip)
        }
        const exportShas = await listMigrationExportShas()
        for (const workspace of workspaces) {
          if (
            shouldEnqueueCronHydrate({
              migrationExportSha: exportShas.get(workspace.id) ?? null,
              desiredSha: desiredById.get(workspace.id) ?? null,
              activeProjectionSha: workspace.activeProjectionSha,
              writeStatus: workspace.writeStatus,
            })
          ) {
            void enqueueWorkspaceHydrate(
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
            void enqueueWorkspaceIndex(
              {
                orgId: input.orgId,
                workspaceId: row.id,
                gitUrl: row.workspaceRepositoryUrl,
                desiredSha: item.resolvedTip,
                role: "workspace",
                jobGeneration: row.desiredGeneration,
                jobWorkspaceUrl: row.workspaceRepositoryUrl,
              },
              { error: () => undefined },
            )
          }
        }
        const linked = await listOrgLinkedRepositories(input.orgId)
        const linkedUpdated = await runCronLinkedTipChecks({
          linked,
          resolveTip: (gitUrl, desiredRef) =>
            resolveWorkspaceRepositoryTip({
              orgId: input.orgId,
              workspaceRepositoryUrl: gitUrl,
              branch: desiredRef,
              env,
            }),
          persist: persistLinkedDesiredSha,
        })
        for (const item of linkedUpdated) {
          const row = linked.find((linkedRow) => linkedRow.id === item.linkedId)
          if (!row) continue
          const workspace = workspaces.find(
            (item) => item.id === row.workspaceId,
          )
          if (!workspace) continue
          void enqueueWorkspaceIndex(
            {
              orgId: input.orgId,
              workspaceId: row.workspaceId,
              gitUrl: row.gitUrl,
              desiredSha: item.resolvedTip,
              role: "linked",
              linkedId: row.id,
              jobGeneration: workspace.desiredGeneration,
              jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
            },
            { error: () => undefined },
          )
        }
        const now = new Date()
        const idleChats = chatSandboxesDueForDestroy({
          conversations: await listOrgConversationsForSandboxGc(input.orgId),
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
        return { updated: updated.length, linkedUpdated: linkedUpdated.length }
      }),
    )
  },
)
