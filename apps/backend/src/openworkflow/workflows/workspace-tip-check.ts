import { trace } from "@opentelemetry/api"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { githubRepositoriesWithoutAccess } from "../../domain/workspace-sources/github-access.js"
import { shouldSkipCommitProjection } from "../../domain/workspaces/commit-activity.js"
import {
  collectInactiveWorkspaceGraphKeys,
  loadWorkspaceGraphKeysInUse,
} from "../../domain/workspaces/graph-gc.js"
import { rebuildWorkspaceGraphWhenMissing } from "../../domain/workspaces/graph-rebuild.js"
import {
  resolveLinkedReadRevision,
  resolveWorkspaceReadRevision,
} from "../../domain/workspaces/resolve-revision.js"
import {
  publishedProjection,
  type WorkspaceRevision,
} from "../../domain/workspaces/revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  desiredProjectionRevision,
  servedSha,
  shouldEnqueueCronHydrate,
} from "../../domain/workspaces/tip-resolve.js"
import { withFormatWriteGate } from "../../domain/workspaces/workspace-format.js"
import {
  destroySandboxesForWorkspace,
  jobSandboxesDueForDestroy,
} from "../../domain/workspaces/workspace-sandbox-cleanup.js"
import { cleanUpWorkspaceIngestRefs } from "../../domain/workspaces/write-broker.js"
import { resumePausedWriteJobs } from "../../domain/workspaces/write-job-resume.js"
import {
  nextPersistedWriteProbe,
  probeWorkspaceWriteAccess,
} from "../../domain/workspaces/write-status.js"
import { orgHasRecentIngestionRun } from "../../models/ingestion-runs.js"
import { failStoppedUpgradeRun } from "../../models/workspace-upgrades.js"
import { getWorkspaceCommitProjection } from "../../models/workspace-commits.js"
import { listUnfinishedHydrateShas } from "../../models/workspace-hydrate-runs.js"
import {
  claimPausedWriteJob,
  ensureOrgFirstWorkspace,
  getWorkspaceProjection,
  listOrgLinkedRepositories,
  listOrgWorkspaces,
  listPausedWriteJobs,
  persistWriteStatus,
  reconcileStaleWriteJobs,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { getGithubRepoWriteView } from "../../routes/webhooks/github/github-workspace-tip.js"
import {
  GIT_REMOTE_ACCESS_MESSAGES,
  GitRemoteAccessError,
} from "../../services/git/clone-tree.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueWorkspaceCommitProjection } from "../enqueue-workspace-commit-projection.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"
import {
  type EnqueueWorkspaceWriteCommitInput,
  enqueueWorkspaceWriteCommit,
} from "../enqueue-workspace-write-commit.js"
import { scheduleConversationSandboxSweep } from "./conversation-sandbox-sweep.js"

/** A Workspace in the no-access state reads its remote again after this, or after a retry or a reconnect. */
const NO_ACCESS_RETRY_MS = 6 * 60 * 60 * 1000

function inNoAccessBackoff(
  workspace: {
    hydrateStatus: string
    hydrateError: string | null
    updatedAt: Date
  },
  now: Date,
): boolean {
  return (
    workspace.hydrateStatus === "failed" &&
    Object.values<string | null>(GIT_REMOTE_ACCESS_MESSAGES).includes(
      workspace.hydrateError,
    ) &&
    now.getTime() - workspace.updatedAt.getTime() < NO_ACCESS_RETRY_MS
  )
}

function remoteHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : "local"
}

function tipJobKey(revision: WorkspaceRevision, hour: string): string {
  return `${revision.workspaceId}:${revision.generation}:${revision.defaultBranch}:${revision.sha}:${hour}`
}

const workspaceTipCheckInputSchema = z.object({
  orgId: z.string().min(1),
  /**
   * The UTC hour (`YYYY-MM-DDTHH`) that the retry keys hold. The cron does not
   * give it, so the check uses the current hour. A test gives it, so that its
   * keys do not depend on the clock.
   */
  hour: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
    .optional(),
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
        ensureOrgFirstWorkspace(input.orgId),
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
          // An upgrade run that stopped without its result shows as
          // `failed`. The upgrades read writes nothing, so this check does it.
          await failStoppedUpgradeRun(workspace.id)
          if (!(await persistWriteStatus(workspace, write, input.orgId)))
            return []
          // The format gate is on top of the stored probe result.
          const gated = withFormatWriteGate({
            ...write,
            formatVersion: workspace.formatVersion,
          })
          writeStatusById.set(workspace.id, gated.writeStatus)
          if (gated.writeStatus !== "writable") return []
          const pending: EnqueueWorkspaceWriteCommitInput[] = []
          // A job that stays `queued` or `running` for an hour lost its run,
          // or its run ended and nothing recorded that. Record a failed run
          // on the job, and pause a job that has no run, so that the resume
          // step below queues it again with its own id.
          await reconcileStaleWriteJobs(
            workspace,
            new Date(Date.now() - 60 * 60 * 1000),
          )
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
      const startedAt = new Date()
      const noAccess = new Set<string>()
      let linkedNoAccess = 0
      const skipWithoutAccess = (
        error: unknown,
        target: { workspaceId: string; linkId?: string; url: string },
      ): void => {
        if (!(error instanceof GitRemoteAccessError)) throw error
        log.warn({
          event: "workspace_tip_check_no_access",
          workspaceId: target.workspaceId,
          linkId: target.linkId,
          repositoryHost: remoteHost(target.url),
          status: error.status,
        })
      }
      for (const workspace of workspaces) {
        if (inNoAccessBackoff(workspace, startedAt)) {
          noAccess.add(workspace.id)
          continue
        }
        const resolved = await resolveWorkspaceReadRevision({
          orgId: input.orgId,
          workspaceId: workspace.id,
          env,
          refresh: true,
        }).catch((error: unknown) => {
          skipWithoutAccess(error, {
            workspaceId: workspace.id,
            url: workspace.workspaceRepositoryUrl,
          })
          noAccess.add(workspace.id)
          return null
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
      const unfinishedHydrates = await listUnfinishedHydrateShas(input.orgId)
      const hour = input.hour ?? startedAt.toISOString().slice(0, 13)
      // The knowledge export of main-era data is upgrade step 1. It goes
      // only through the upgrade pull request that an owner or admin opens
      // (ADR-053), so the tip check never writes it to the default branch.
      for (const workspace of workspaces) {
        if (noAccess.has(workspace.id)) continue
        const projection = await getWorkspaceProjection(workspace.id)
        const desired = desiredProjectionRevision(projection)
        // An earlier run can store the tip in `desired_sha` and then fail
        // before it queues the hydrate. Thus compare `desired_sha` with the
        // served SHA, not the tip with `desired_sha`. A hydrate of the same
        // SHA that is not finished blocks a second one. The key names the
        // served SHA, the desired SHA and the UTC hour, so a failed or stale
        // pair is queued again at most once an hour.
        if (
          desired &&
          !unfinishedHydrates.has(`${workspace.id}:${desired.sha}`) &&
          (servedSha(projection, desired) !== desired.sha ||
            shouldEnqueueCronHydrate({ projection }))
        ) {
          // A run can also fail after it stores the tip and before it queues
          // the index job below. Queue it again with the same rule and hour
          // as the hydrate. When the hydrate publishes, it queues the index
          // itself.
          if (
            servedSha(projection, desired) !== desired.sha &&
            !updated.some((item) => item.workspaceId === workspace.id)
          ) {
            await enqueueWorkspaceIndex(
              { orgId: input.orgId, revision: { ...desired, access: "read" } },
              quietLog,
              {
                idempotencyKey: `workspace-tip-index:${tipJobKey(desired, hour)}`,
              },
            )
          }
          await enqueueWorkspaceHydrate(
            { orgId: input.orgId, workspaceId: workspace.id },
            { error: () => undefined },
            {
              idempotencyKey: (revision) =>
                `workspace-tip-hydrate:${revision.workspaceId}:${revision.generation}:${revision.defaultBranch}:${servedSha(projection, revision) ?? "none"}:${revision.sha}:${hour}`,
            },
          )
        }
        // A run can also fail after it stores the tip and before it queues
        // the commit projection job below. A hydrate that it queued can then
        // publish the tip, so the check above does not apply. Thus compare
        // the commit projection with `desired_sha`, and queue it again at
        // most once an hour.
        if (
          desired &&
          !updated.some((item) => item.workspaceId === workspace.id)
        ) {
          const commits = await getWorkspaceCommitProjection(workspace.id)
          if (
            !shouldSkipCommitProjection({
              headSha: commits?.headSha ?? null,
              desiredSha: desired.sha,
              status: commits?.backfillStatus ?? "pending",
            })
          )
            await enqueueWorkspaceCommitProjection(
              { orgId: input.orgId, workspaceId: workspace.id },
              quietLog,
              {
                idempotencyKey: `workspace-tip-commits:${tipJobKey(desired, hour)}`,
              },
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
      // A GitHub source records the repositories that its connection cannot
      // read (`out_of_access`). Skip them until a new check finds access.
      const withoutAccess = await githubRepositoriesWithoutAccess({
        orgId: input.orgId,
        env,
        now: startedAt,
      })
      let linkedUpdated = 0
      for (const row of linked) {
        if (
          withoutAccess.has(
            `${row.workspaceId} ${normalizeWorkspaceRepositoryUrl(row.gitUrl)}`,
          )
        ) {
          linkedNoAccess += 1
          continue
        }
        const resolved = await resolveLinkedReadRevision({
          orgId: input.orgId,
          linkId: row.id,
          env,
        }).catch((error: unknown) => {
          skipWithoutAccess(error, {
            workspaceId: row.workspaceId,
            linkId: row.id,
            url: row.gitUrl,
          })
          linkedNoAccess += 1
          return null
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
      // A no-access read is an expected state, not a span error.
      trace.getActiveSpan()?.setAttributes({
        "ctxpipe.tip_check.no_access_workspaces": noAccess.size,
        "ctxpipe.tip_check.no_access_linked": linkedNoAccess,
      })
      const now = new Date()
      // Also restarts the sandbox sweep chain if it was ever lost.
      await scheduleConversationSandboxSweep(input.orgId, now)
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
      // Stale run-scoped ingest refs (ADR-052), only for an org with an
      // ingestion v2 run in the last 7 days. A failure here must not fail the
      // tip check; the next check tries again.
      if (
        await orgHasRecentIngestionRun(
          input.orgId,
          new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        )
      )
        for (const workspace of workspaces) {
          if (
            !workspace.githubConnectionId ||
            noAccess.has(workspace.id) ||
            (writeStatusById.get(workspace.id) ?? workspace.writeStatus) !==
              "writable"
          )
            continue
          await cleanUpWorkspaceIngestRefs(
            { orgId: input.orgId, workspaceId: workspace.id, now },
            env,
          ).catch((error: unknown) => {
            log.warn({
              event: "workspace_ingest_ref_cleanup_failed",
              workspaceId: workspace.id,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        }
      // A ready graph that the graph store does not hold gets one rebuild, for
      // example after a new projection version. The checks run one at a time,
      // and each is one small marker read. A failure here must not fail
      // the tip check; the next check tries again.
      for (const workspace of workspaces)
        await rebuildWorkspaceGraphWhenMissing({
          orgId: org.id,
          orgSlug: org.slug,
          projection: publishedProjection(
            await getWorkspaceProjection(workspace.id),
          ),
        }).catch((error: unknown) => {
          log.warn({
            event: "workspace_graph_rebuild_check_failed",
            workspaceId: workspace.id,
            message: error instanceof Error ? error.message : String(error),
          })
        })
      // Remove the graphs of keys that no Workspace uses. A key goes only
      // after a grace period, so a chat turn that is shorter than the grace
      // period can still read the key it captured. A failure here must not
      // fail the tip check either.
      await collectInactiveWorkspaceGraphKeys({
        orgId: org.id,
        orgSlug: org.slug,
        loadUse: () => loadWorkspaceGraphKeysInUse(org.id),
      }).catch((error: unknown) => {
        log.warn({
          event: "workspace_graph_gc_failed",
          message: error instanceof Error ? error.message : String(error),
        })
      })
      return { updated: updated.length, linkedUpdated }
    })
  },
)
