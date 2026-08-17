import { sandboxSnapshotKey } from "./revision.js"
import type { WorkspaceWriteKind } from "./write-commit-files.js"
import {
  fallbackCommitSubject,
  shouldPushWorkspaceWriteJob,
} from "./write-jobs.js"

export const JOB_WORKTREE_PREFIX = "job"
export const MAX_CONCURRENT_JOB_WORKTREES = 4

const MECHANICAL_WRITE_KINDS = new Set<WorkspaceWriteKind>([
  "migration_export",
  "link_unlink",
  "connector_mirror",
])

export function jobUsesInSandboxWorktree(kind: WorkspaceWriteKind): boolean {
  return !MECHANICAL_WRITE_KINDS.has(kind)
}

export function jobCommitPath(input: {
  kind: WorkspaceWriteKind
  provider: "docker" | "railway" | "unsandboxed"
}): "github_api" | "worktree" {
  void input.provider
  if (!jobUsesInSandboxWorktree(input.kind)) return "github_api"
  return "worktree"
}

export function jobWorktreeName(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80)
  return `${JOB_WORKTREE_PREFIX}-${safe || "unknown"}`
}

/** One write sandbox per Workspace, keyed by desired URL + SHA. */
export function workspaceWriteSandboxId(input: {
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
}): string | null {
  const snapshot = sandboxSnapshotKey(input.desiredUrl, input.desiredSha)
  if (!snapshot) return null
  return `${input.orgId}:${input.workspaceId}:write:${snapshot}`
}

export function shouldSpawnJobWorktree(input: {
  writeStatus: string
  runningJobCount: number
  maxConcurrent?: number
}): boolean {
  if (input.writeStatus !== "writable") return false
  return (
    input.runningJobCount <
    (input.maxConcurrent ?? MAX_CONCURRENT_JOB_WORKTREES)
  )
}

export function planJobWorktree(input: {
  jobId: string
  kind: WorkspaceWriteKind
  writeStatus: string
  runningJobCount: number
  provider: "docker" | "railway" | "unsandboxed"
}): { spawn: true; worktree: string } | { spawn: false; reason: string } {
  if (!jobUsesInSandboxWorktree(input.kind)) {
    return { spawn: false, reason: "mechanical_github_api" }
  }
  if (jobCommitPath(input) !== "worktree") {
    return { spawn: false, reason: "no_write_sandbox" }
  }
  if (
    !shouldSpawnJobWorktree({
      writeStatus: input.writeStatus,
      runningJobCount: input.runningJobCount,
    })
  ) {
    return { spawn: false, reason: "worktree_cap" }
  }
  return { spawn: true, worktree: jobWorktreeName(input.jobId) }
}

export function runnerCommitMessage(input: {
  repoName: string
  trigger?: string
  llmSubject?: string | null
}): string {
  const llm = input.llmSubject?.trim() ?? ""
  if (
    llm &&
    llm !== "New conversation" &&
    llm.length < 200 &&
    !/[\r\n]/.test(llm)
  ) {
    return llm
  }
  return fallbackCommitSubject({
    repoName: input.repoName,
    trigger: input.trigger,
  })
}

/** Recheck generation, URL, write status, and default branch immediately before push. */
export function livePushRecheck(input: {
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
  defaultBranch: string
  targetBranch: string
}): { push: true } | { push: false; reason: string } {
  return runnerMayPush(input)
}

export function runnerMayPush(input: {
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
  defaultBranch: string
  targetBranch: string
}): { push: true } | { push: false; reason: string } {
  if (input.targetBranch !== input.defaultBranch) {
    return { push: false, reason: "jobs_push_default_only" }
  }
  const gate = shouldPushWorkspaceWriteJob(input)
  if (!gate.push) return { push: false, reason: gate.reason }
  return { push: true }
}

export function capturedWriteParentSha(
  desiredSha: string | null,
): string | null {
  const sha = desiredSha?.trim() ?? ""
  return sha.length > 0 ? sha : null
}

/** Workspace jobs commit against the captured parent, never a newly fetched tip. */
export function casCommitParents(capturedSha: string): [string] {
  return [capturedSha]
}

/** Semantic merge commits onto the live remote tip, not the rejected parent. */
export function semanticMergeCommitParent(input: {
  kind: WorkspaceWriteKind
  capturedParentSha: string | null
  remoteTipSha: string | null
}): string | null {
  if (input.kind === "semantic_merge") {
    return capturedWriteParentSha(input.remoteTipSha)
  }
  return input.capturedParentSha
}

export function planAfterCasRejection(): "enqueue_semantic_merge" {
  return "enqueue_semantic_merge"
}

export function persistJobCommitIfRemoteHasSha(input: {
  recordedCommit: string | null
  remoteSha: string
}): "skip_push_and_hydrate" | "push" {
  if (input.recordedCommit && input.recordedCommit === input.remoteSha) {
    return "skip_push_and_hydrate"
  }
  return "push"
}

export function isNonFastForwardGithubError(error: {
  status?: number
  message?: string
}): boolean {
  const message = (error.message ?? "").toLowerCase()
  return (
    error.status === 409 ||
    error.status === 422 ||
    message.includes("not a fast-forward") ||
    message.includes("update is not a fast forward") ||
    message.includes("cannot be fast-forwarded")
  )
}

/** Mechanical-mirror non-FF: fail that job and enqueue one semantic-merge job. */
export function planAfterMechanicalPushFailure(input: {
  kind: WorkspaceWriteKind
  nonFastForward: boolean
}): "enqueue_semantic_merge" | "fail_job" {
  if (input.kind === "connector_mirror" && input.nonFastForward) {
    return "enqueue_semantic_merge"
  }
  return "fail_job"
}

/** CAS rejection on a captured parent, or mechanical-mirror non-FF, enqueues semantic merge. */
export function shouldEnqueueSemanticMergeOnPushFailure(input: {
  kind: WorkspaceWriteKind
  nonFastForward: boolean
  capturedParentSha: string | null
}): boolean {
  if (
    !input.nonFastForward ||
    !capturedWriteParentSha(input.capturedParentSha)
  ) {
    return false
  }
  if (planAfterCasRejection() === "enqueue_semantic_merge") return true
  return (
    planAfterMechanicalPushFailure({
      kind: input.kind,
      nonFastForward: input.nonFastForward,
    }) === "enqueue_semantic_merge"
  )
}

export function commitSubjectFileNames(
  files: ReadonlyArray<{ path: string }>,
): string[] {
  return files.map((file) => file.path).slice(0, 12)
}

export function planWorkspaceWriteCommit(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  deletePaths?: ReadonlyArray<string>
  existing: ReadonlyMap<string, string>
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
  defaultBranch: string
  targetBranch: string
  repoName: string
  trigger?: string
  llmSubject?: string | null
  kind?: WorkspaceWriteKind
}):
  | { action: "skip"; reason: "no_changes" | "paused" | string }
  | {
      action: "commit"
      files: Array<{ path: string; content: string }>
      deletePaths: string[]
      message: string
    } {
  const gate = runnerMayPush(input)
  if (!gate.push) return { action: "skip", reason: gate.reason }
  const files = input.files.filter(
    (file) => input.existing.get(file.path) !== file.content,
  )
  const deletePaths = [...(input.deletePaths ?? [])].filter((path) =>
    input.kind === "semantic_merge" ? true : input.existing.has(path),
  )
  if (files.length === 0 && deletePaths.length === 0) {
    return { action: "skip", reason: "no_changes" }
  }
  return {
    action: "commit",
    files,
    deletePaths,
    message: runnerCommitMessage({
      repoName: input.repoName,
      trigger: input.trigger,
      llmSubject: input.llmSubject,
    }),
  }
}

export async function executeWorkspaceWriteCommit(input: {
  plan: ReturnType<typeof planWorkspaceWriteCommit>
  commit: (
    files: Array<{ path: string; content: string }>,
    message: string,
    deletePaths: string[],
  ) => Promise<{ commitSha: string }>
}): Promise<
  { committed: false; reason: string } | { committed: true; commitSha: string }
> {
  if (input.plan.action === "skip") {
    return { committed: false, reason: input.plan.reason }
  }
  const result = await input.commit(
    input.plan.files,
    input.plan.message,
    input.plan.deletePaths,
  )
  return { committed: true, commitSha: result.commitSha }
}
