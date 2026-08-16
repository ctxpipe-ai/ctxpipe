import { chatSandboxAllowsRemotePush } from "./chat-sandbox-policy.js"

export const CHAT_SANDBOX_IDLE_MS = 30 * 60 * 1000
export const JOB_SANDBOX_IDLE_MS = 60 * 60 * 1000
export const CHAT_HEARTBEAT_INTERVAL_MS = 60 * 1000
export const CHAT_SESSION_BRANCH_PREFIX = "ctxpipe/chat"

export function chatSessionBranchName(
  conversationId: string,
  prNumber: number,
): string {
  return `${CHAT_SESSION_BRANCH_PREFIX}/${conversationId}/${prNumber}`
}

export function nextChatPrNumber(lastChatPrNumber: number | null): number {
  return (lastChatPrNumber ?? 0) + 1
}

export function planChatPullRequest(input: {
  writeStatus: string
  explicitRequest: boolean
  host: "github" | "other"
  defaultBranch: string
  capturedDefaultBranch: string | null
  capturedGeneration: number | null
  desiredGeneration: number
  capturedUrl: string | null
  desiredUrl: string
  capturedSha: string | null
  desiredSha: string | null
}): { publish: true } | { publish: false; reason: string } {
  if (input.capturedUrl == null || input.capturedUrl !== input.desiredUrl) {
    return { publish: false, reason: "stale_url" }
  }
  if (
    input.capturedGeneration == null ||
    input.capturedGeneration !== input.desiredGeneration
  ) {
    return { publish: false, reason: "stale_generation" }
  }
  if (input.capturedSha == null || input.capturedSha !== input.desiredSha) {
    return { publish: false, reason: "stale_sha" }
  }
  if (
    input.capturedDefaultBranch == null ||
    input.capturedDefaultBranch !== input.defaultBranch
  ) {
    return { publish: false, reason: "stale_default_branch" }
  }
  if (
    !chatMayPublishPullRequest({
      writeStatus: input.writeStatus,
      explicitRequest: input.explicitRequest,
      host: input.host,
    })
  ) {
    return { publish: false, reason: "not_allowed" }
  }
  return { publish: true }
}

export function chatMayPublishPullRequest(input: {
  writeStatus: string
  explicitRequest: boolean
  host: "github" | "other"
}): boolean {
  if (!input.explicitRequest) return false
  if (input.host !== "github") return false
  return chatSandboxAllowsRemotePush(input.writeStatus)
}

export function shouldDestroyChatSandbox(input: {
  conversationDeleted: boolean
  lastTurnAt: Date | null
  now: Date
}): boolean {
  if (input.conversationDeleted) return true
  if (!input.lastTurnAt) return true
  return (
    input.now.getTime() - input.lastTurnAt.getTime() >= CHAT_SANDBOX_IDLE_MS
  )
}

export function shouldDestroyJobSandbox(input: {
  desiredUrlChanged: boolean
  runningOrQueued: boolean
  lastJobAt: Date | null
  now: Date
}): boolean {
  if (input.desiredUrlChanged) return true
  if (input.runningOrQueued) return false
  if (!input.lastJobAt) return true
  return input.now.getTime() - input.lastJobAt.getTime() >= JOB_SANDBOX_IDLE_MS
}

export type QuietUpdateDecision =
  | { action: "reset_to_tip" }
  | { action: "rebase_onto_tip" }
  | { action: "stay_stale" }

export function treeDirtyFromPorcelain(stdout: string): boolean {
  return stdout.trim().length > 0
}

export function quietUpdateGitCommand(input: {
  action: QuietUpdateDecision["action"]
  desiredSha: string
}): string | null {
  if (input.action === "reset_to_tip") {
    return `git reset --hard ${input.desiredSha}`
  }
  if (input.action === "rebase_onto_tip") {
    return `git rebase ${input.desiredSha}`
  }
  return null
}

export async function applyQuietChatUpdate(input: {
  decision: QuietUpdateDecision
  desiredSha: string
  exec: (
    command: string,
    options?: { env?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}): Promise<{
  applied: boolean
  action: QuietUpdateDecision["action"]
}> {
  const command = quietUpdateGitCommand({
    action: input.decision.action,
    desiredSha: input.desiredSha,
  })
  if (!command) {
    return { applied: false, action: input.decision.action }
  }
  const result = await input.exec(command, { env: {} })
  if (result.exitCode !== 0 && input.decision.action === "rebase_onto_tip") {
    return { applied: false, action: "stay_stale" }
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Quiet update failed: ${command}`)
  }
  return { applied: true, action: input.decision.action }
}

export function quietUpdateChatBranch(input: {
  lastBranch: string | null
  defaultBranch: string
  lastBranchPublished: boolean
  treeDirty: boolean
  rebaseApplies: boolean
}): QuietUpdateDecision {
  const onDefault =
    !input.lastBranch || input.lastBranch === input.defaultBranch
  if (onDefault && !input.treeDirty) return { action: "reset_to_tip" }
  if (input.rebaseApplies) return { action: "rebase_onto_tip" }
  if (input.lastBranchPublished && !onDefault) return { action: "stay_stale" }
  return { action: "reset_to_tip" }
}

export function lastBranchExistsOnRemote(input: {
  lastBranch: string | null
  remoteBranches: Iterable<string>
}): boolean {
  if (!input.lastBranch) return false
  return [...input.remoteBranches].includes(input.lastBranch)
}

export function chatHeartbeatKeepsSandbox(input: {
  turnInProgress: boolean
}): boolean {
  return input.turnInProgress
}

export function shouldHeartbeatChatSandbox(input: {
  turnInProgress: boolean
  lastHeartbeatAt: Date | null
  now: Date
}): boolean {
  if (!chatHeartbeatKeepsSandbox({ turnInProgress: input.turnInProgress })) {
    return false
  }
  if (!input.lastHeartbeatAt) return true
  return (
    input.now.getTime() - input.lastHeartbeatAt.getTime() >=
    CHAT_HEARTBEAT_INTERVAL_MS
  )
}

/** Dirtiness never publishes. Only an explicit user/agent request does. */
export function promptRequestsChatPullRequest(prompt: string): boolean {
  return /\b(open|create|publish|update)\b.{0,40}\b(pr|pull request)\b/i.test(
    prompt,
  )
}

export function restoreBranchAfterIdle(input: {
  lastBranch: string | null
  lastBranchExistsOnRemote: boolean
  defaultBranch: string
}): string {
  if (input.lastBranch && input.lastBranchExistsOnRemote)
    return input.lastBranch
  return input.defaultBranch
}

export function mayForcePushBranch(
  branch: string,
  defaultBranch: string,
): boolean {
  return (
    branch !== defaultBranch &&
    branch.startsWith(`${CHAT_SESSION_BRANCH_PREFIX}/`)
  )
}
