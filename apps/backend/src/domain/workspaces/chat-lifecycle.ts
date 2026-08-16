import { chatSandboxAllowsRemotePush } from "./chat-sandbox-policy.js"

export const CHAT_SANDBOX_IDLE_MS = 30 * 60 * 1000
export const JOB_SANDBOX_IDLE_MS = 60 * 60 * 1000
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
