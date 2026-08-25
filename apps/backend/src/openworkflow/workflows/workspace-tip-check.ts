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
  listMigrationExportJobWorkspaceIds,
  listMigrationExportShas,
  listOrgLinkedRepositories,
  listOrgWorkspaces,
  listPausedWriteJobs,
  reconcileDestWorkspaceAssignment,
  persistLinkedDesiredSha,
  persistResolvedDesiredSha,
  persistWriteStatus,
} from "../../models/workspaces.js"
import {
  getGithubRepoWriteView,
  resolveWorkspaceRepositoryTip,
} from "../../routes/webhooks/github/github-workspace-tip.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"
import {
  enqueueWorkspaceWriteCommit,
  type EnqueueWorkspaceWriteCommitInput,
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
        writeStatusById.set(workspace.id, probe.writeStatus)
        const claimed = await withOrgDbContext(input.orgId, async () => {
          await persistWriteStatus(workspace.id, probe, input.orgId)
          if (probe.writeStatus !== "writable") return []
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
        persist: (row) =>
          withOrgDbContext(input.orgId, () => persistResolvedDesiredSha(row)),
        reloadDesiredSha: async (workspaceId) =>
          withOrgDbContext(
            input.orgId,
            async () =>
              (await getWorkspaceById(workspaceId))?.desiredSha ?? null,
          ),
      })
      const desiredById = new Map(
        workspaces.map((row) => [row.id, row.desiredSha]),
      )
      for (const item of updated) {
        desiredById.set(item.workspaceId, item.resolvedTip)
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
          shouldEnqueueCronHydrate({
            migrationExportSha: exportShas.get(workspace.id) ?? null,
            desiredSha: desiredById.get(workspace.id) ?? null,
            activeProjectionSha: workspace.activeProjectionSha,
            writeStatus: writeStatusById.get(workspace.id),
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
      const linked = await withOrgDbContext(input.orgId, () =>
        listOrgLinkedRepositories(input.orgId),
      )
      const linkedUpdated = await runCronLinkedTipChecks({
        linked,
        resolveTip: (gitUrl, desiredRef) =>
          resolveWorkspaceRepositoryTip({
            orgId: input.orgId,
            workspaceRepositoryUrl: gitUrl,
            branch: desiredRef,
            env,
          }),
        persist: (row) =>
          withOrgDbContext(input.orgId, () => persistLinkedDesiredSha(row)),
      })
      for (const item of linkedUpdated) {
        const row = linked.find((linkedRow) => linkedRow.id === item.linkedId)
        if (!row) continue
        const workspace = workspaces.find((item) => item.id === row.workspaceId)
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
      return { updated: updated.length, linkedUpdated: linkedUpdated.length }
    })
  },
)
