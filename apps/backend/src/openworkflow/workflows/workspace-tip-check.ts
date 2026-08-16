import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  chatSandboxesDueForDestroy,
  destroySandboxesForConversation,
  destroySandboxesForWorkspace,
  jobSandboxesDueForDestroy,
} from "../../domain/workspaces/sandbox-registry.js"
import {
  runCronLinkedTipChecks,
  runCronTipChecks,
} from "../../domain/workspaces/tip-resolve.js"
import { listOrgConversationsForSandboxGc } from "../../models/conversations.js"
import {
  getWorkspaceById,
  listOrgLinkedRepositories,
  listOrgWorkspaces,
  persistLinkedDesiredSha,
  persistResolvedDesiredSha,
} from "../../models/workspaces.js"
import { resolveWorkspaceRepositoryTip } from "../../routes/webhooks/github/github-workspace-tip.js"
import { enqueueWorkspaceCutover } from "../enqueue-workspace-cutover.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"

const workspaceTipCheckInputSchema = z.object({
  orgId: z.string().min(1),
})

export const workspaceTipCheck = defineWorkflow(
  { name: "workspace-tip-check", schema: workspaceTipCheckInputSchema },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    return withOrgDbContext(input.orgId, async () => {
      void enqueueWorkspaceCutover(input.orgId, { error: () => undefined })
      const workspaces = await listOrgWorkspaces(input.orgId)
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
      for (const item of updated) {
        const row = workspaces.find(
          (workspace) => workspace.id === item.workspaceId,
        )
        void enqueueWorkspaceHydrate(
          { orgId: input.orgId, workspaceId: item.workspaceId },
          { error: () => undefined },
        )
        if (row) {
          void enqueueWorkspaceIndex(
            {
              orgId: input.orgId,
              workspaceId: row.id,
              gitUrl: row.workspaceRepositoryUrl,
              desiredSha: item.resolvedTip,
              role: "workspace",
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
        void enqueueWorkspaceIndex(
          {
            orgId: input.orgId,
            workspaceId: row.workspaceId,
            gitUrl: row.gitUrl,
            desiredSha: item.resolvedTip,
            role: "linked",
            linkedId: row.id,
          },
          { error: () => undefined },
        )
      }
      const now = new Date()
      const idleChats = chatSandboxesDueForDestroy({
        conversations: await listOrgConversationsForSandboxGc(),
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
    })
  },
)
