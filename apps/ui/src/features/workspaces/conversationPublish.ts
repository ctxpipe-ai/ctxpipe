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

/** Every error code the Commit+Push and Create PR routes answer. */
export type PublishErrorCode =
  | "missing_conversation"
  | "missing_workspace"
  | "read_only"
  | "not_github"
  | "not_allowed"
  | "workspace_required"
  | "default_branch"
  | "other_branch"
  | "nothing_committed"
  | "no_changes"
  | "no_write_access"
  | "no_pr_access"
  | "stale_url"
  | "stale_generation"
  | "stale_sha"
  | "stale_default_branch"
  | "stale_connection"
  | "stale_binding"
  | "missing_sandbox"
  | "rebase_in_progress"
  | "session_moved"
  | "push_failed"
  | "turn_running"
  | "pr_merged"
  | "github_unavailable"
  | "sandbox_capacity"
  | "sandbox_unavailable"

const workspaceMoved = "The Workspace moved. Reload the page and try again."

const publishErrorMessages: Record<PublishErrorCode, string> = {
  missing_conversation: "This conversation no longer exists.",
  missing_workspace: "This conversation has no Workspace.",
  read_only: "This Workspace is read-only.",
  not_github: "This Workspace is not on GitHub.",
  not_allowed: "You can't publish from this conversation.",
  workspace_required: "This conversation needs a Workspace.",
  default_branch:
    "ctx| never pushes to the default branch. Ask the agent to work on its own branch.",
  other_branch:
    "The sandbox is on another branch. Ask the agent to switch back to the conversation branch.",
  nothing_committed:
    "There are no commits yet. Use Commit+Push to commit the files.",
  no_changes: "There are no changes to publish.",
  no_write_access: "The ctx| GitHub App can't push to this repository.",
  no_pr_access:
    "The ctx| GitHub App can't open pull requests. Give it the Pull requests: Read and write permission.",
  stale_url: workspaceMoved,
  stale_generation: workspaceMoved,
  stale_sha: workspaceMoved,
  stale_default_branch: workspaceMoved,
  stale_connection: workspaceMoved,
  stale_binding: workspaceMoved,
  missing_sandbox: "The sandbox stopped. Send a message to start it again.",
  rebase_in_progress: "A rebase is in progress. Ask the agent to finish it.",
  session_moved:
    "The branch on GitHub has commits ctx| did not push. Ask the agent to fetch and rebase.",
  push_failed: "Git or GitHub refused the push. Try again.",
  turn_running: "The agent is still working. Try again when the turn ends.",
  pr_merged:
    "The pull request was merged. Send a message to continue on a new branch.",
  github_unavailable: "GitHub did not answer. Try again.",
  sandbox_capacity: "Too many sandboxes are running. Try again later.",
  sandbox_unavailable: "The sandbox is not available. Try again.",
}

/** The toast text for a failed Commit+Push or Create PR. */
export function conversationPublishErrorMessage(
  action: "Commit+Push" | "Create PR",
  error: unknown,
): string {
  const code = error instanceof Error ? error.message : String(error)
  const reason = Object.hasOwn(publishErrorMessages, code)
    ? publishErrorMessages[code as PublishErrorCode]
    : undefined
  return reason ? `${action} failed. ${reason}` : `${action} failed (${code}).`
}
