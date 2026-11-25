import { createHash } from "node:crypto"

import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import {
  connectorMirrorContentSchema,
  connectorMirrorSourceSchema,
} from "../../domain/workspaces/connector-mirror-input.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  assertWriteOriginAllowed,
  writeOriginSchema,
} from "../../domain/workspaces/semantic-merge.js"
import {
  attemptWorkspaceCommit,
  publishWorkspaceWriteRevision,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  completedWorkspaceWrite,
  completeWorkspaceWrite,
  prepareSemanticMergeCommit,
  readSemanticMergeChange,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  discardWriteJobPreparedCommit,
  persistBoundWriteJob,
  validateSemanticHandoff,
} from "../../models/workspace-write-jobs.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import {
  gitFileChangeSchema,
  repositoryFilePathSchema,
} from "../../services/git/file-change.js"
import { readGitFiles } from "../../services/git/pack.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  acquireOnCurrentTip,
  holdWorkspaceMergeLease,
} from "../workspace-merge-lease-steps.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

export const semanticMergeContentSchema = z
  .object({
    mirror: connectorMirrorSourceSchema.optional(),
    /**
     * Retired: the handoff of the old pipeline. A run that was
     * queued with it still parses, and it ends with no write.
     */
    extraction: z.record(z.string(), z.unknown()).optional(),
    previousSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    files: z.array(gitFileChangeSchema),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine((input) => {
    const paths = [
      ...input.files.map((file) => file.path),
      ...input.deletePaths,
    ]
    return new Set(paths).size === paths.length
  }, "Each path must have exactly one operation")
  .refine(
    (input) =>
      !input.mirror ||
      connectorMirrorContentSchema.safeParse({
        mirror: input.mirror,
        files: input.files,
        deletePaths: input.deletePaths,
      }).success,
    "Connector handoff must retain its managed paths",
  )

const semanticMergeCommandSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  jobId: z.string().min(1),
  revision: workspaceRevisionSchema,
  origin: writeOriginSchema,
})

const handoffSchema = z
  .object({
    ownerRunId: z.string().min(1),
    candidateSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict()

/**
 * A semantic merge carries its files (a standalone merge), or it is the
 * handoff child of a write that lost the push race. A handoff names the
 * candidate commit of the parent on its job ref, never its files
 * (CTX-1239): the child reads the change from Git. A handoff child that was
 * queued before CTX-1239 carries its files, and it still parses.
 */
export const workspaceSemanticMergeInputSchema = z
  .union([
    semanticMergeContentSchema.safeExtend({
      ...semanticMergeCommandSchema.shape,
      handoff: handoffSchema.optional(),
    }),
    semanticMergeCommandSchema
      .extend({
        mirror: connectorMirrorSourceSchema.optional(),
        previousSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        handoff: handoffSchema.extend({
          /** Paths of the candidate change that stay off the new tip. */
          dropPaths: z.array(repositoryFilePathSchema).min(1).optional(),
        }),
      })
      .strict(),
  ])
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

/** The most attempts of one merge before it fails. */
const MERGE_ATTEMPTS = 8

/**
 * The wait after attempt `attempt` (from 0) lost the push race to another
 * writer: 1 s, then twice as long each time (64 s before the last of the
 * `MERGE_ATTEMPTS`). A hash of the job id adds up to the same time again, so
 * writers that lost together do not try again together. The waits of a
 * merge are at most about 4 minutes.
 */
function raceBackoff(jobId: string, attempt: number): `${number}s` {
  const base = 2 ** attempt
  const spread =
    createHash("sha256").update(`${jobId}:${attempt}`).digest().readUInt8(0) /
    256
  return `${Math.round(base * (1 + spread))}s`
}

export const workspaceSemanticMerge = defineWorkflow(
  {
    name: "workspace-write-semantic-merge",
    schema: workspaceSemanticMergeInputSchema,
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceSemanticMergeInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-semantic-merge",
      async () => {
        const env = parseEnv(process.env)
        // Read access to the bound repository, from the workflow input (CTX-955).
        const read = workspaceGitRead({
          orgId: input.orgId,
          env,
          remote: input.revision.remote,
        })
        let revision = input.revision
        const repositoryName = githubRepoFullNameFromWorkspaceUrl(
          revision.remote.url,
        )
        const connectionId = revision.remote.connectionId
        if (!repositoryName || !connectionId)
          throw new Error(
            "Workspace writes require a connected GitHub repository",
          )
        const completed = input.handoff
          ? await validateSemanticHandoff({ ...input, handoff: input.handoff })
          : await completedWorkspaceWrite(input, "semantic_merge", run.id)
        if (completed) return completed
        if ("extraction" in input && input.extraction) {
          // The old pipeline is gone: no ingestion writes to a
          // Workspace below format 3. A handoff that it queued ends here.
          await step.run({ name: "complete-retired" }, () =>
            persistWriteJobStatus(
              input.jobId,
              "completed",
              "The old ingestion pipeline is retired. Its queued semantic_merge handoff ends with no write; ingestion v2 publishes to a Workspace at format 3 or more.",
            ),
          )
          return {
            committed: false as const,
            reason: "legacy_ingestion_retired" as const,
            commitSha: undefined,
          }
        }
        // A standalone merge has its files and no handoff.
        if (!input.handoff && "files" in input)
          await step.run({ name: "claim-command" }, () =>
            persistBoundWriteJob({
              id: input.jobId,
              kind: "semantic_merge",
              mirror: input.mirror,
              revision: input.revision,
              workflowRunId: run.id,
              previousSha: input.previousSha,
              files: input.files,
              deletePaths: input.deletePaths,
            }),
          )
        // One semantic merge or ingestion publish of a Workspace runs at a
        // time (CTX-1598, CTX-1621).
        const { release: releaseLease } = await holdWorkspaceMergeLease(step, {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          runId: run.id,
        })
        for (
          let refreshAttempt = 0;
          refreshAttempt < MERGE_ATTEMPTS;
          refreshAttempt++
        ) {
          const next = await acquireOnCurrentTip(step, input, revision, env, {
            refresh: refreshAttempt === 0,
          })
          const { acquired } = next
          revision = next.revision
          // Check every path the write changes, not only the paths that
          // conflict, as the origin requires (CTX-722).
          if (input.origin !== "host")
            await step.run(
              {
                name: "check-agent-write",
                retryPolicy: { maximumAttempts: 1 },
              },
              async () => {
                const change = await readSemanticMergeChange(input, read)
                const paths = new Set(change.files.map((file) => file.path))
                const current = new Map(
                  (
                    await readGitFiles(
                      acquired.pack,
                      (path) => paths.has(path),
                      undefined,
                      read,
                    )
                  ).map((file) => [file.path, file.content] as const),
                )
                assertWriteOriginAllowed({
                  origin: input.origin,
                  ...change,
                  current,
                })
              },
            )
          const committed = await runJobRefStep(
            step,
            input.jobId,
            {
              name: "prepare-merge-commit",
              // A provider error fails the step. Wait longer before each
              // new attempt, so that a short outage does not fail the
              // write (CTX-958).
              retryPolicy: {
                maximumAttempts: 4,
                initialInterval: "30s",
                backoffCoefficient: 2,
                maximumInterval: "120s",
              },
            },
            () =>
              prepareSemanticMergeCommit(
                input,
                revision,
                acquired.pack,
                run.createdAt,
                env,
              ),
          )
          if (!committed) {
            const refreshed = await step.run({ name: "confirm-no-op" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
            )
            if (!sameWorkspaceRevision(refreshed, revision)) {
              revision = refreshed
              continue
            }
            await releaseLease()
            await step.run({ name: "enqueue-no-op-hydrate" }, () =>
              enqueueWorkflow(
                workspaceHydrate.spec,
                {
                  orgId: input.orgId,
                  workspaceId: input.workspaceId,
                  revision,
                },
                { idempotencyKey: `${input.jobId}:hydrate` },
              ),
            )
            if (!input.handoff)
              await step.run({ name: "complete-no-op" }, () =>
                persistWriteJobStatus(input.jobId, "completed"),
              )
            return {
              committed: false as const,
              reason: "no_changes" as const,
            }
          }
          let pushed: Awaited<ReturnType<typeof attemptWorkspaceCommit>>
          for (;;) {
            const attempt = await step.run(
              { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
              () => attemptWorkspaceCommit(input, revision, committed, env),
            )
            pushed = attempt
            if (pushed.pushed || pushed.reason !== "paused") break
            await step.run({ name: "pause-push" }, () =>
              persistWriteJobStatus(input.jobId, "paused"),
            )
            await step.sleep("await-default-write-access", "1 minute")
            await step.run({ name: "resume-push" }, () =>
              persistWriteJobStatus(input.jobId, "running"),
            )
          }
          if (!pushed.pushed) {
            await step.run({ name: "discard-unpublished-candidate" }, () =>
              discardWriteJobPreparedCommit(input.jobId, committed.sha),
            )
            // Another writer (a connector mirror, ingestion) moved the
            // default branch. An attempt at once loses again while the other
            // writer pushes in a burst, so wait longer before each new
            // attempt. Read the tip after the wait: the next attempt merges
            // onto the pushes of the wait too (CTX-1304).
            if (refreshAttempt < MERGE_ATTEMPTS - 1)
              await step.sleep(
                "await-quiet-default-branch",
                raceBackoff(input.jobId, refreshAttempt),
              )
            revision = await step.run({ name: "refresh-raced-revision" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
            )
            continue
          }
          await releaseLease()
          const published = await step.run({ name: "publish-result" }, () =>
            publishWorkspaceWriteRevision(input, revision, committed, env),
          )
          await step.run({ name: "enqueue-hydrate" }, async () => {
            await enqueueWorkflow(
              workspaceHydrate.spec,
              {
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                revision: published,
              },
              { idempotencyKey: `${input.jobId}:hydrate` },
            )
          })
          if (!input.handoff)
            await step.run({ name: "complete" }, () =>
              completeWorkspaceWrite(
                { ...input, remote: input.revision.remote },
                committed.sha,
                env,
              ),
            )
          return { committed: true as const, commitSha: committed.sha }
        }
        await releaseLease()
        throw new Error("Default branch kept changing during semantic merge")
      },
    )
  },
)
