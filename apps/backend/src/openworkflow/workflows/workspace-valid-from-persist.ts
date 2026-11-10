import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { validFromPersistFiles } from "../../domain/workspaces/hydrate-write-jobs.js"
import { hydrateKnowledgeTree } from "../../domain/workspaces/hydrate.js"
import {
  resolveRepositoryReadCredential,
  workspaceGitRead,
} from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import {
  attemptWorkspaceCommit,
  captureSemanticHandoff,
  publishWorkspaceWriteRevision,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  completedWorkspaceWrite,
  completeWorkspaceWrite,
  prepareWorkspaceWriteCommit,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { persistBoundWriteJob } from "../../models/workspace-write-jobs.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import { readGitFiles } from "../../services/git/pack.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

const inputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

export const workspaceValidFromPersist = defineWorkflow(
  { name: "workspace-write-valid-from-persist", schema: inputSchema },
  async ({ input: queuedInput, step, run }) => {
    const input = inputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-valid-from-persist",
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
        const completed = await completedWorkspaceWrite(
          input,
          "valid_from_persist",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "valid_from_persist",
            revision: input.revision,
            workflowRunId: run.id,
          }),
        )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          let acquired: NonNullable<
            Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
          >
          for (;;) {
            const candidate = await step.run(
              { name: "acquire-revision-v2" },
              () => acquireWorkspaceWriteRevision(input, revision, env),
            )
            if (candidate) {
              acquired = candidate
              break
            }
            await step.run({ name: "pause-command" }, () =>
              persistWriteJobStatus(input.jobId, "paused"),
            )
            await step.sleep("await-write-access", "1 minute")
            await step.run({ name: "resume-command" }, () =>
              persistWriteJobStatus(input.jobId, "running"),
            )
          }
          // One step makes the change, commits it, and pushes the commit to
          // its job ref: no step output holds a file (CTX-1239).
          const committed = await runJobRefStep(
            step,
            input.jobId,
            { name: "prepare-commit" },
            () =>
              prepareWorkspaceWriteCommit(
                input,
                revision,
                acquired.pack,
                {
                  change: async () => {
                    const token = await resolveRepositoryReadCredential({
                      orgId: input.orgId,
                      env,
                      remote: revision.remote,
                    })
                    const introduced = new Map<string, string>()
                    for (const file of await listMarkdownFilesAtGitSha({
                      url: revision.remote.url,
                      sha: revision.sha,
                      token,
                      includeIntroducingCommits: true,
                      root: workspaceRootPath(revision),
                    }))
                      if (file.introducingCommitTimestamp)
                        introduced.set(file.path, file.introducingCommitTimestamp)
                    const sourceFiles = await readGitFiles(
                      acquired.pack,
                      (path) => path.endsWith(".md"),
                      undefined,
                      read,
                    )
                    const parsed = hydrateKnowledgeTree({
                      workspaceId: input.workspaceId,
                      files: sourceFiles,
                    })
                    const files = sourceFiles.flatMap((file) => {
                      const timestamp = introduced.get(file.path)
                      const changes = validFromPersistFiles({
                        files: [file],
                        units: parsed.units,
                        introducingCommitTimestamp: timestamp ?? "",
                      })
                      if (changes.length && !timestamp)
                        throw new Error(
                          "Missing native introducing timestamp for a claim repair",
                        )
                      return changes
                    })
                    if (files.some((file) => !file.path.endsWith(".md")))
                      throw new Error(
                        "Validity maintenance may only edit Markdown",
                      )
                    return { files, deletePaths: [] }
                  },
                  subject: { trigger: "valid_from_persist" },
                  createdAt: run.createdAt,
                },
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
            pushed = await step.run(
              { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
              () => attemptWorkspaceCommit(input, revision, committed, env),
            )
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
            const handoff = await step.run(
              { name: "capture-semantic-handoff-v2" },
              () =>
                captureSemanticHandoff(input, revision, committed, env, "host"),
            )
            const result = await step.runWorkflow(
              workspaceSemanticMerge.spec,
              handoff,
              { name: "semantic-merge-child" },
            )
            await step.run({ name: "complete-merged-result" }, () =>
              completeWorkspaceWrite(
                { ...input, remote: input.revision.remote },
                result.committed ? result.commitSha : null,
                env,
              ),
            )
            return result
          }
          const published = await step.run({ name: "publish-result" }, () =>
            publishWorkspaceWriteRevision(input, revision, committed, env),
          )
          await step.run({ name: "enqueue-hydrate" }, async () => {
            await runWorkflowWithWorkerWake(
              workspaceHydrate.spec,
              {
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                revision: published,
              },
              { idempotencyKey: `${input.jobId}:hydrate` },
            )
          })
          await step.run({ name: "complete" }, () =>
            completeWorkspaceWrite(
              { ...input, remote: input.revision.remote },
              committed.sha,
              env,
            ),
          )
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
