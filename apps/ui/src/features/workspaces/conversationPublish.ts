import type { ConversationPrState } from "@/features/chat/types"

export function conversationAllowsEdits(
  writeStatus: string,
  conversationWritable?: boolean,
): boolean {
  return conversationWritable ?? writeStatus === "writable"
}

/** `ctxpipe/chat/<conversation>/<n>` shows as `chat/<n>`. */
export function conversationBranchShortName(branch: string): string {
  const session = /^ctxpipe\/chat\/[^/]+\/(\d+)$/.exec(branch)
  return session ? `chat/${session[1]}` : branch
}

export function conversationPullRequestAction(
  prState: ConversationPrState | string | null | undefined,
): "create" | "show" {
  return prState === "open" ? "show" : "create"
}

export function conversationGithubTreeHref(
  workspaceRepositoryUrl: string,
  branch: string,
): string | null {
  try {
    const parsed = new URL(workspaceRepositoryUrl)
    if (parsed.hostname.toLowerCase() !== "github.com") return null
    const [owner, repoWithGit] = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
    const repo = repoWithGit?.replace(/\.git$/, "")
    if (!owner || !repo) return null
    return `https://github.com/${owner}/${repo}/tree/${branch}`
  } catch {
    return null
  }
}

export type ConversationPublishStatus = {
  dirty: boolean
  differsFromDefault: boolean
  unpushed: boolean
  /** The session branch is on GitHub. */
  published?: boolean
  /** Commits ahead of the default branch. */
  ahead?: number
  stale?: boolean
} | null

/**
 * Commit+Push publishes what the conversation branch on GitHub lacks: files
 * nobody committed yet and commits the agent made but did not push.
 */
export function conversationCommitPushEnabled(
  status: ConversationPublishStatus,
): boolean {
  if (!status || status.stale) return false
  return status.dirty || status.unpushed
}

/**
 * Create PR publishes commits: those on GitHub already, or ones Create PR
 * pushes first. Uncommitted files alone are Commit+Push's.
 */
export function conversationCreatePrEnabled(
  status: ConversationPublishStatus,
): boolean {
  if (!status || status.stale) return false
  return Boolean(status.published) || (status.ahead ?? 0) > 0
}

export function conversationPullRequestVisible(
  status: ConversationPublishStatus,
  action: "create" | "show",
): boolean {
  return action === "show" || conversationCreatePrEnabled(status)
}
