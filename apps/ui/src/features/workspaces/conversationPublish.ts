import type { ConversationPrState } from "@/features/chat/types"

export function conversationSessionBranch(conversationId: string): string {
  return `ctxpipe/chat/${conversationId}/1`
}

export function conversationAllowsEdits(writeStatus: string): boolean {
  return writeStatus === "writable"
}

export function conversationBranchShortName(branch: string): string {
  return branch.startsWith("ctxpipe/chat/") ? "chat/1" : branch
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

export function conversationCommitPushEnabled(status: {
  dirty: boolean
  differsFromDefault: boolean
  unpushed: boolean
} | null): boolean {
  if (!status) return false
  return status.dirty || status.differsFromDefault || status.unpushed
}
