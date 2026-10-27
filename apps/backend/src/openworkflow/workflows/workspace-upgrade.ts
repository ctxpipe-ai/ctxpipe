import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import {
  chooseUpgradeBranch,
  listUpgradePullRequests,
} from "../../domain/upgrades/branch.js"
import {
  buildUpgradeCommits,
  upgradePullRequestText,
} from "../../domain/upgrades/build-commits.js"
import {
  pushUpgradeBranch,
  UpgradeWriteAccessError,
} from "../../domain/upgrades/push-branch.js"
import {
  GIT_UPGRADE_STEPS,
  type GitUpgradeStep,
  targetFormatOfKey,
  UPGRADE_BLOCKED_REASONS,
  UPGRADE_STATUSES,
  upgradeBranch,
  upgradeJobId,
  upgradeTargetFormat,
} from "../../domain/upgrades/registry.js"
import { runUpgradeStage } from "../../domain/upgrades/run-stage.js"
import { resolveRepositoryReadCredential } from "../../domain/workspaces/resolve-revision.js"
import {
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import {
  CODE_FORMAT,
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
} from "../../domain/workspaces/workspace-format.js"
import { withWorkspaceWriteContext } from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import { readGitFiles, readGitPackFromRemote } from "../../services/git/pack.js"
import {
  createPullRequestFromBranch,
  listOpenPullRequestsByBranchPrefix,
  parseGithubPullNumberFromUrl,
  updatePullRequestText,
} from "../../services/github/installation-write-client.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"

export const workspaceUpgradeInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    key: z.string().min(1),
  })
  .strict()

type UpgradeInput = z.infer<typeof workspaceUpgradeInputSchema>

const builtSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blocked"), note: z.string() }),
  z.object({ kind: z.literal("current"), format: z.number() }),
  z.object({
    kind: z.literal("pushed"),
    branch: z.string(),
    revision: workspaceRevisionSchema,
    fromFormat: z.number(),
    headSha: z.string(),
    steps: z.array(
      z.object({
        format: z.number(),
        title: z.string(),
        sha: z.string().nullable(),
        report: z.array(z.string()),
        notices: z
          .array(
            z.object({ kind: z.enum(["action", "risk"]), text: z.string() }),
          )
          .optional(),
      }),
    ),
  }),
])

/**
 * Make the upgrade commits on the default branch of the Workspace and push
 * them to the upgrade branch. Nothing is pushed to the default branch.
 */
async function buildAndPushUpgrade(input: {
  upgrade: UpgradeInput
  steps: readonly GitUpgradeStep[]
  targetFormat: number
  createdAt: Date
  runId: string
}): Promise<z.infer<typeof builtSchema>> {
  const { orgId, workspaceId } = input.upgrade
  const stage = <T>(name: "read" | "build" | "push", work: () => Promise<T>) =>
    runUpgradeStage(
      { workspaceId, key: input.upgrade.key, runId: input.runId, stage: name },
      work,
    )
  const env = parseEnv(process.env)
  const admission = await getWorkspaceWriteAdmission(workspaceId)
  if (!admission) throw new Error("The Workspace has no repository binding")
  // The admission has the format gate: a format file that is not valid or
  // newer than this code makes the Workspace read-only.
  if (admission.writeStatus === "read_only")
    return {
      kind: "blocked",
      note:
        admission.readOnlyReason ?? "ctxpipe cannot write to this repository.",
    }
  const revision: WorkspaceRevision = { ...admission.revision, access: "read" }
  const token = await resolveRepositoryReadCredential({
    orgId,
    env,
    remote: revision.remote,
  })
  const { pack, read } = await stage("read", async () => {
    const pack = await readGitPackFromRemote({
      url: revision.remote.url,
      sha: revision.sha,
      token,
      root: workspaceRootPath(revision),
    })
    const [file] = await readGitFiles(
      pack,
      (path) => path === WORKSPACE_FORMAT_PATH,
      undefined,
      null,
    )
    return { pack, read: readWorkspaceFormat(file?.content ?? null) }
  })
  if (read.kind === "invalid")
    throw new Error(`${WORKSPACE_FORMAT_PATH} is not valid: ${read.error}`)
  if (read.format >= input.targetFormat || read.format > CODE_FORMAT)
    return { kind: "current", format: read.format }
  const built = await stage("build", () =>
    buildUpgradeCommits({
      pack,
      steps: input.steps,
      fromFormat: read.format,
      targetFormat: input.targetFormat,
      ctx: {
        orgId,
        workspaceId,
        baseSha: revision.sha,
        remote: {
          url: revision.remote.url,
          connectionId: revision.remote.connectionId ?? null,
        },
        introducedAt: async () =>
          new Map(
            (
              await listMarkdownFilesAtGitSha({
                url: revision.remote.url,
                sha: revision.sha,
                token,
                includeIntroducingCommits: true,
                root: workspaceRootPath(revision),
              })
            ).flatMap((file) =>
              file.introducingCommitTimestamp
                ? [[file.path, file.introducingCommitTimestamp] as const]
                : [],
            ),
          ),
      },
      createdAt: input.createdAt,
    }),
  )
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const githubConnectionId = revision.remote.connectionId
  let branch = upgradeBranch(input.targetFormat)
  try {
    // A pull request of another person on the branch name keeps its branch:
    // ctxpipe pushes to the next free suffixed name instead.
    if (repositoryName && githubConnectionId)
      branch = chooseUpgradeBranch(
        await listUpgradePullRequests(
          { orgId, env, repositoryName, githubConnectionId },
          branch,
        ),
        branch,
      )
    await stage("push", () =>
      pushUpgradeBranch({
        orgId,
        revision,
        committed: built.pack,
        branch,
        env,
      }),
    )
  } catch (error) {
    if (error instanceof UpgradeWriteAccessError)
      return { kind: "blocked", note: error.reason }
    throw error
  }
  return {
    kind: "pushed",
    branch,
    revision,
    fromFormat: read.format,
    headSha: built.pack.sha,
    steps: built.steps,
  }
}

/** Update the open pull request of the upgrade branch, or open one. */
async function openOrUpdatePullRequest(input: {
  orgId: string
  built: Extract<z.infer<typeof builtSchema>, { kind: "pushed" }>
  targetFormat: number
}): Promise<
  | { kind: "open"; prNumber: number; prUrl: string }
  | { kind: "stale" }
  | { kind: "blocked"; note: string }
  | { kind: "failed"; reason: string }
> {
  const { revision } = input.built
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const connectionId = revision.remote.connectionId
  if (!repositoryName || !connectionId)
    return {
      kind: "blocked",
      note: "The Workspace repository is not connected with the GitHub App.",
    }
  const github = {
    orgId: input.orgId,
    env: parseEnv(process.env),
    repositoryName,
    githubConnectionId: connectionId,
  }
  const branch = input.built.branch
  const text = upgradePullRequestText({
    fromFormat: input.built.fromFormat,
    targetFormat: input.targetFormat,
    steps: input.built.steps,
  })
  const [open] = await listOpenPullRequestsByBranchPrefix({
    ...github,
    branchPrefix: branch,
    exactBranch: branch,
  })
  const openNumber = open ? parseGithubPullNumberFromUrl(open.pullUrl) : null
  if (open && openNumber) {
    await updatePullRequestText({ ...github, pullNumber: openNumber, ...text })
    return { kind: "open", prNumber: openNumber, prUrl: open.pullUrl }
  }
  const created = await createPullRequestFromBranch({
    ...github,
    revision: { ...revision, access: "publish-session" },
    baseBranch: revision.defaultBranch,
    branch,
    ...text,
  })
  if (!created) return { kind: "stale" }
  if ("refused" in created)
    return created.refused === "no_pr_access"
      ? {
          kind: "blocked",
          note: "The GitHub App cannot open pull requests on this repository. Grant Pull requests: write.",
        }
      : { kind: "failed", reason: created.githubMessage }
  return { kind: "open", prNumber: created.pullNumber, prUrl: created.pullUrl }
}

/**
 * Build the upgrade workflow for a list of steps. Production uses
 * {@link GIT_UPGRADE_STEPS}; a test gives its own steps under the same name.
 *
 * One run handles one upgrade row that an owner or admin started (status
 * `queued`): claim, read the format at the default branch, plan and commit
 * each pending step, force-push the upgrade branch, open or update the pull
 * request, and record it (`pr_open`). The merge of the pull request
 * completes the upgrade: hydrate records the new format, and the scan that
 * it queues sets the row to `completed`.
 */
export function defineWorkspaceUpgrade(steps: readonly GitUpgradeStep[]) {
  return defineWorkflow(
    { name: "workspace-upgrade", schema: workspaceUpgradeInputSchema },
    async ({ input: queuedInput, step, run }) => {
      const input = workspaceUpgradeInputSchema.parse(queuedInput)
      const targetFormat = targetFormatOfKey(input.key)
      if (targetFormat === null || targetFormat > upgradeTargetFormat(steps))
        throw new Error(`Unknown upgrade key ${input.key}`)
      const { workspaceId, key } = input
      return withWorkspaceWriteContext(
        { ...input, jobId: upgradeJobId(workspaceId, key) },
        "workspace-upgrade",
        async () => {
          const claimed = await step.run({ name: "claim" }, async () => {
            if (
              await transitionWorkspaceUpgradeRow({
                workspaceId,
                key,
                from: [UPGRADE_STATUSES.queued],
                to: UPGRADE_STATUSES.running,
                workflowRunId: run.id,
                failureReason: null,
              })
            )
              return { ok: true, status: UPGRADE_STATUSES.running }
            const row = await getWorkspaceUpgradeRow(workspaceId, key)
            return {
              ok:
                row?.status === UPGRADE_STATUSES.running &&
                row.workflowRunId === run.id,
              status: row?.status ?? null,
            }
          })
          if (!claimed.ok) return { started: false, status: claimed.status }
          const finish = (
            to: (typeof UPGRADE_STATUSES)[keyof typeof UPGRADE_STATUSES],
            fields: Omit<
              Parameters<typeof transitionWorkspaceUpgradeRow>[0],
              "workspaceId" | "key" | "from" | "to" | "ownerRunId"
            >,
          ) =>
            step.run({ name: `record-${to}` }, async () => {
              await transitionWorkspaceUpgradeRow({
                workspaceId,
                key,
                from: [UPGRADE_STATUSES.running],
                to,
                ownerRunId: run.id,
                ...fields,
              })
              return { started: true, status: to }
            })
          try {
            // A new commit on the default branch between the push and the
            // pull request makes the plan stale; plan again on the new tip.
            for (let attempt = 0; attempt < 3; attempt++) {
              const built = builtSchema.parse(
                await step.run(
                  {
                    name: "build-and-push-branch",
                    retryPolicy: { maximumAttempts: 3 },
                  },
                  () =>
                    buildAndPushUpgrade({
                      upgrade: input,
                      steps,
                      targetFormat,
                      createdAt: run.createdAt,
                      runId: run.id,
                    }),
                ),
              )
              if (built.kind === "blocked")
                return finish(UPGRADE_STATUSES.blocked, {
                  upgrade: {
                    blockedReason: UPGRADE_BLOCKED_REASONS.writeAccess,
                    note: built.note,
                  },
                })
              if (built.kind === "current")
                return finish(UPGRADE_STATUSES.completed, {
                  upgrade: { fromFormat: built.format, note: undefined },
                })
              const pull = await step.run(
                {
                  name: "open-or-update-pull-request",
                  retryPolicy: { maximumAttempts: 3 },
                },
                () =>
                  runUpgradeStage(
                    { workspaceId, key, runId: run.id, stage: "open" },
                    () =>
                      openOrUpdatePullRequest({
                        orgId: input.orgId,
                        built,
                        targetFormat,
                      }),
                  ),
              )
              if (pull.kind === "stale") continue
              if (pull.kind === "blocked")
                return finish(UPGRADE_STATUSES.blocked, {
                  upgrade: {
                    blockedReason: UPGRADE_BLOCKED_REASONS.writeAccess,
                    note: pull.note,
                  },
                })
              if (pull.kind === "failed") {
                getLogger().error(new Error(pull.reason), {
                  step: "workspace-upgrade.failed",
                  upgradeKey: key,
                })
                return finish(UPGRADE_STATUSES.failed, {
                  failureReason: pull.reason,
                })
              }
              return finish(UPGRADE_STATUSES.pr_open, {
                desiredSha: built.revision.sha,
                upgrade: {
                  branch: built.branch,
                  fromFormat: built.fromFormat,
                  prNumber: pull.prNumber,
                  prUrl: pull.prUrl,
                  steps: built.steps,
                  blockedReason: undefined,
                  note: undefined,
                },
              })
            }
            throw new Error(
              "The default branch kept changing while ctxpipe opened the upgrade pull request",
            )
          } catch (error) {
            if (isWorkflowControlSignal(error)) throw error
            // The row keeps a short reason for the card; the log keeps the
            // error with its stack for the operator.
            getLogger().error(
              error instanceof Error ? error : new Error(String(error)),
              { step: "workspace-upgrade.failed", upgradeKey: key },
            )
            return finish(UPGRADE_STATUSES.failed, {
              failureReason:
                error instanceof Error ? error.message : String(error),
            })
          }
        },
      )
    },
  )
}

export const workspaceUpgrade = defineWorkspaceUpgrade(GIT_UPGRADE_STEPS)

/** Queue the run of a started upgrade row. A second queue of the same start returns the same run. */
export async function enqueueWorkspaceUpgrade(input: {
  orgId: string
  workspaceId: string
  key: string
  approvedAt: string
}): Promise<void> {
  await runWorkflowWithWorkerWake(
    workspaceUpgrade.spec,
    { orgId: input.orgId, workspaceId: input.workspaceId, key: input.key },
    {
      idempotencyKey: `${upgradeJobId(input.workspaceId, input.key)}:${input.approvedAt}`,
    },
  )
}
