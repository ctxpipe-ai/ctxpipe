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

const publishErrorMessages: Record<string, string> = {
  turn_running: "the agent is still working. Try again when the turn ends.",
  no_changes: "there are no changes to publish.",
  nothing_committed:
    "there are no commits yet. Use Commit+Push to commit the files.",
  no_write_access: "the ctx| GitHub App cannot push to this repository.",
  no_pr_access:
    "the ctx| GitHub App cannot open pull requests. Give it the Pull requests: Read and write permission.",
  session_moved:
    "the branch on GitHub has commits ctx| did not push. Ask the agent to fetch and rebase.",
  rebase_in_progress: "a rebase is in progress. Ask the agent to finish it.",
  pr_merged:
    "the pull request was merged. Send a message to continue on a new branch.",
  push_failed: "Git or GitHub refused the push. Try again.",
  github_unavailable: "GitHub did not answer. Try again.",
  sandbox_unavailable: "the sandbox is not available. Try again.",
  sandbox_capacity: "too many sandboxes are running. Try again later.",
  missing_sandbox: "the sandbox stopped. Send a message to start it again.",
  stale_binding: "the Workspace changed. Reload the page.",
}

/** The toast text for a failed Commit+Push or Create PR. */
export function conversationPublishErrorMessage(
  action: "Commit+Push" | "Create PR",
  error: unknown,
): string {
  const code = error instanceof Error ? error.message : String(error)
  const reason = publishErrorMessages[code]
  return reason ? `${action} failed: ${reason}` : `${action} failed (${code}).`
}
