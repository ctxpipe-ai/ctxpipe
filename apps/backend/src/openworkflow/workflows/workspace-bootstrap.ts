import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  BOOTSTRAP_SKILL_PATH,
  bootstrapWorkspaceFiles,
} from "../../domain/workspaces/bootstrap.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { resolveRepositoryReadCredential } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  publishWorkspaceWriteRevision,
  pushWorkspaceCommit,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import { isBootstrapAllowedPath } from "../../domain/workspaces/write-jobs.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  getWorkspaceWriteJob,
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceById,
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import {
  captureGitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

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

export const workspaceBootstrap = defineWorkflow(
  { name: "workspace-write-bootstrap", schema: inputSchema },
  async ({ input: queuedInput, step, run }) => {
    const input = inputSchema.parse(queuedInput)
    return withLogger(
      createLogger({
        workflow: "workspace-write-bootstrap",
        workspaceId: input.workspaceId,
        jobId: input.jobId,
      }),
      async () => {
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })
        if (!org) throw new Error("Organization not found")
        return withOrgIdContext(org, async () => {
          const env = parseEnv(process.env)
          let revision = input.revision
          const repositoryName = githubRepoFullNameFromWorkspaceUrl(
            revision.remote.url,
          )
          const connectionId = revision.remote.connectionId
          if (!repositoryName || !connectionId)
            throw new Error(
              "Workspace writes require a connected GitHub repository",
            )
          const recorded = await getWorkspaceWriteJob(input.jobId)
          if (recorded) {
            if (
              recorded.workspaceId !== input.workspaceId ||
              recorded.kind !== "bootstrap" ||
              !sameWorkspaceRevision(recorded.payload?.revision, revision)
            )
              throw new Error(
                "Write job id is already bound to a different command",
              )
            if (recorded.status === "completed")
              return recorded.commitSha
                ? { committed: true as const, commitSha: recorded.commitSha }
                : { committed: false as const, reason: "no_changes" as const }
            if (
              recorded.payload?.workflowRunId &&
              recorded.payload.workflowRunId !== run.id
            )
              throw new Error(
                "Write job is already owned by another workflow run",
              )
          }
          await step.run({ name: "claim-command" }, () =>
            persistBoundWriteJob({
              id: input.jobId,
              kind: "bootstrap",
              revision: input.revision,
              workflowRunId: run.id,
            }),
          )
          for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
            const acquired = await step.run(
              { name: "acquire-revision" },
              async () => {
                const workspace = await getWorkspaceById(input.workspaceId)
                const current = await getDesiredWorkspaceRevision(
                  input.workspaceId,
                  "write-default",
                )
                if (!workspace || !sameWorkspaceRevision(current, revision))
                  throw new Error("Workspace write binding changed")
                if (workspace.writeStatus !== "writable")
                  throw new Error("Workspace is not writable")

                const token = await resolveRepositoryReadCredential({
                  orgId: input.orgId,
                  env,
                  remote: revision.remote,
                })
                const pack = await withGitDirectory(
                  revision.sha,
                  async (directory) => {
                    await nativeGit(
                      directory,
                      [
                        "fetch",
                        "--depth",
                        "1",
                        "--",
                        revision.remote.url,
                        revision.sha,
                      ],
                      undefined,
                      gitRemoteEnvironment({ url: revision.remote.url, token }),
                    )
                    return captureGitPack(directory, revision.sha)
                  },
                )
                return { pack, displayName: workspace.displayName }
              },
            )
            const files = await step.run({ name: "transform-bootstrap" }, () =>
              withGitDirectory(
                revision.sha,
                async (directory) => {
                  const paths = (
                    await nativeGit(directory, [
                      "ls-tree",
                      "-r",
                      "--name-only",
                      "-z",
                      revision.sha,
                    ])
                  )
                    .toString()
                    .split("\0")
                  const existing = new Map<string, string>()
                  for (const path of ["AGENTS.md", BOOTSTRAP_SKILL_PATH]) {
                    if (paths.includes(path))
                      existing.set(
                        path,
                        (
                          await nativeGit(directory, [
                            "show",
                            `${revision.sha}:${path}`,
                          ])
                        ).toString(),
                      )
                  }
                  return bootstrapWorkspaceFiles({
                    displayName: acquired.displayName,
                    existing,
                  }).filter((file) => existing.get(file.path) !== file.content)
                },
                acquired.pack,
              ),
            )
            if (!files.length) {
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
            const staged = await step.run({ name: "stage" }, () => {
              if (files.some((file) => !isBootstrapAllowedPath(file.path)))
                throw new Error("Bootstrap path is outside its allowed files")
              return stageGitFiles(acquired.pack, files)
            })
            await step.run({ name: "validate" }, () =>
              validateGitTree(
                staged,
                files.map((file) => file.path),
              ),
            )
            const subject = await step.run({ name: "commit-subject" }, () =>
              generateCommitSubject({
                repoName: repositoryName.split("/")[1] ?? repositoryName,
                trigger: "bootstrap",
                fileNames: files.map((file) => file.path),
              }),
            )
            const committed = await step.run({ name: "commit" }, async () => {
              const pack = await commitGitTree(staged, {
                subject,
                createdAt: run.createdAt,
              })
              await persistWriteJobPreparedCommit(input.jobId, pack.sha)
              return pack
            })
            await step.run(
              { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
              () => pushWorkspaceCommit(input, revision, committed, env),
            )
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
              persistWriteJobCommitSha(input.jobId, committed.sha),
            )
            return { committed: true as const, commitSha: committed.sha }
          }
          throw new Error(
            "Default branch kept changing during no-op validation",
          )
        })
      },
    )
  },
)
