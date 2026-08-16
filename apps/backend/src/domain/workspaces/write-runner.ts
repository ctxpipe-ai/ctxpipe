import {
  fallbackCommitSubject,
  shouldPushWorkspaceWriteJob,
} from "./write-jobs.js"

export const JOB_WORKTREE_PREFIX = "job"

export function jobWorktreeName(jobId: string): string {
  return `${JOB_WORKTREE_PREFIX}-${jobId}`
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

export function persistJobCommitIfRemoteHasSha(input: {
  recordedCommit: string | null
  remoteSha: string
}): "skip_push_and_hydrate" | "push" {
  if (input.recordedCommit && input.recordedCommit === input.remoteSha) {
    return "skip_push_and_hydrate"
  }
  return "push"
}

export function planWorkspaceWriteCommit(input: {
  files: ReadonlyArray<{ path: string; content: string }>
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
}):
  | { action: "skip"; reason: "no_changes" | "paused" | string }
  | {
      action: "commit"
      files: Array<{ path: string; content: string }>
      message: string
    } {
  const gate = runnerMayPush(input)
  if (!gate.push) return { action: "skip", reason: gate.reason }
  const files = input.files.filter(
    (file) => input.existing.get(file.path) !== file.content,
  )
  if (files.length === 0) return { action: "skip", reason: "no_changes" }
  return {
    action: "commit",
    files,
    message: runnerCommitMessage({
      repoName: input.repoName,
      trigger: input.trigger,
      llmSubject: input.llmSubject,
    }),
  }
}
