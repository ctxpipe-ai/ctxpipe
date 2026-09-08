import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
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
import { isBootstrapAllowedPath } from "../../domain/workspaces/write-jobs.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import {
  getWorkspaceWriteJob,
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  captureWorkspaceRevision,
  getDesiredWorkspaceRevision,
  getWorkspaceById,
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import {
  captureGitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
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
          const revision = input.revision
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
              await persistBoundWriteJob({
                id: input.jobId,
                kind: "bootstrap",
                revision,
                workflowRunId: run.id,
              })
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
            await step.run({ name: "complete-no-op" }, () =>
              persistWriteJobStatus(input.jobId, "completed"),
            )
            return { committed: false as const, reason: "no_changes" as const }
          }
          const staged = await step.run({ name: "stage" }, () =>
            withGitDirectory(
              revision.sha,
              async (directory) => {
                for (const file of files) {
                  if (!isBootstrapAllowedPath(file.path))
                    throw new Error(
                      "Bootstrap path is outside its allowed files",
                    )
                  const blob = (
                    await nativeGit(
                      directory,
                      ["hash-object", "-w", "--stdin"],
                      file.content,
                    )
                  )
                    .toString()
                    .trim()
                  await nativeGit(directory, [
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    `100644,${blob},${file.path}`,
                  ])
                }
                const tree = (await nativeGit(directory, ["write-tree"]))
                  .toString()
                  .trim()
                // Include the staged tree with its blobs in the same native pack.
                const objects = await nativeGit(
                  directory,
                  ["pack-objects", "--stdout", "--revs"],
                  `${revision.sha}\n${tree}\n`,
                )
                return {
                  pack: {
                    ...acquired.pack,
                    objects: objects.toString("base64"),
                  },
                  tree,
                }
              },
              acquired.pack,
            ),
          )
          await step.run({ name: "validate" }, () =>
            withGitDirectory(
              revision.sha,
              async (directory) => {
                const changed = (
                  await nativeGit(directory, [
                    "diff-tree",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "-z",
                    revision.sha,
                    staged.tree,
                  ])
                )
                  .toString()
                  .split("\0")
                  .filter(Boolean)
                if (
                  !changed.length ||
                  changed.some((path) => !isBootstrapAllowedPath(path))
                )
                  throw new Error("Invalid bootstrap tree")
                await nativeGit(directory, [
                  "diff-tree",
                  "--check",
                  revision.sha,
                  staged.tree,
                ])
              },
              staged.pack,
            ),
          )
          const subject = await step.run({ name: "commit-subject" }, () =>
            generateCommitSubject({
              repoName: repositoryName.split("/")[1] ?? repositoryName,
              trigger: "bootstrap",
              fileNames: files.map((file) => file.path),
            }),
          )
          const committed = await step.run({ name: "commit" }, () =>
            withGitDirectory(
              revision.sha,
              async (directory) => {
                const date = new Date(run.createdAt).toISOString()
                const commitSha = (
                  await nativeGit(
                    directory,
                    ["commit-tree", staged.tree, "-p", revision.sha],
                    `${subject}\n`,
                    {
                      ...process.env,
                      GIT_AUTHOR_NAME: "ctxpipe[bot]",
                      GIT_AUTHOR_EMAIL: "ctxpipe[bot]@users.noreply.github.com",
                      GIT_COMMITTER_NAME: "ctxpipe[bot]",
                      GIT_COMMITTER_EMAIL:
                        "ctxpipe[bot]@users.noreply.github.com",
                      GIT_AUTHOR_DATE: date,
                      GIT_COMMITTER_DATE: date,
                    },
                  )
                )
                  .toString()
                  .trim()
                await persistWriteJobPreparedCommit(input.jobId, commitSha)
                return captureGitPack(directory, commitSha)
              },
              staged.pack,
            ),
          )
          await step.run(
            { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
            async () => {
              const current = await getDesiredWorkspaceRevision(
                input.workspaceId,
                "write-default",
              )
              const workspace = await getWorkspaceById(input.workspaceId)
              if (
                !workspace ||
                (!sameWorkspaceRevision(current, revision) &&
                  !sameWorkspaceRevision(current, {
                    ...revision,
                    sha: committed.sha,
                  })) ||
                workspace.writeStatus !== "writable"
              )
                throw new Error("Workspace write binding changed before push")
              const readToken = await resolveRepositoryReadCredential({
                orgId: input.orgId,
                env,
                remote: revision.remote,
              })
              const tip = await resolveGitRemoteTip({
                url: revision.remote.url,
                token: readToken,
              })
              if (tip?.branch !== revision.defaultBranch)
                throw new Error("Default branch changed before push")
              if (tip.sha === committed.sha) return
              if (tip.sha !== revision.sha)
                throw new Error(
                  "Default branch advanced; semantic merge is required",
                )
              const token = await getRepoWriteCloneToken(input.orgId, env, {
                githubConnectionId: connectionId,
                repoFullName: repositoryName,
              })
              if (!token) throw new Error("No repository write credential")
              await withGitDirectory(
                committed.sha,
                async (directory) => {
                  // Recheck the actual default after remote credential I/O.
                  const pushTip = await resolveGitRemoteTip({
                    url: revision.remote.url,
                    token,
                  })
                  if (pushTip?.branch !== revision.defaultBranch)
                    throw new Error(
                      "Default branch changed during credential issuance",
                    )
                  if (
                    pushTip.sha !== revision.sha &&
                    pushTip.sha !== committed.sha
                  )
                    throw new Error(
                      "Default branch advanced; semantic merge is required",
                    )
                  // Credential acquisition and pack restoration may outlive a relink.
                  const admitted = await getDesiredWorkspaceRevision(
                    input.workspaceId,
                    "write-default",
                  )
                  const live = await getWorkspaceById(input.workspaceId)
                  if (
                    !sameWorkspaceRevision(admitted, revision) ||
                    live?.writeStatus !== "writable"
                  )
                    throw new Error(
                      "Workspace write binding changed during credential issuance",
                    )
                  if (pushTip.sha === committed.sha) return
                  await nativeGit(
                    directory,
                    [
                      "push",
                      "--porcelain",
                      "--",
                      revision.remote.url,
                      `${committed.sha}:refs/heads/${revision.defaultBranch}`,
                    ],
                    undefined,
                    gitRemoteEnvironment({ url: revision.remote.url, token }),
                  )
                },
                committed,
              )
            },
          )
          const published = await step.run(
            { name: "publish-result" },
            async () => {
              return withOrgDbContext(input.orgId, async () => {
                const captured = await captureWorkspaceRevision({
                  workspaceId: input.workspaceId,
                  expected: {
                    generation: revision.generation,
                    url: revision.remote.url,
                    sha: revision.sha,
                    defaultBranch: revision.defaultBranch,
                    githubConnectionId: revision.remote.connectionId,
                  },
                  tip: { sha: committed.sha, branch: revision.defaultBranch },
                })
                if (captured) return captured
                const current = await getDesiredWorkspaceRevision(
                  input.workspaceId,
                )
                return sameWorkspaceRevision(current, {
                  ...revision,
                  sha: committed.sha,
                  access: "read",
                })
                  ? current
                  : null
              })
            },
          )
          if (published)
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
        })
      },
    )
  },
)
