import { cleanTitle, isUnnamedConversation } from "./conversation-title.js"
import { maskCredentials } from "./mask-credentials.js"

/** What the session branch adds to the default branch, as GitHub compares them. */
export type BranchChanges = {
  /** Full commit messages, oldest first. */
  commits: string[]
  files: Array<{ path: string; status: string }>
}

/**
 * The pull request title: the conversation name as one clean line. Without a
 * usable name, a title that names the changed files.
 */
export function pullRequestTitle(
  name: string | null | undefined,
  changes: BranchChanges,
): string {
  const title = isUnnamedConversation(name) ? "" : cleanTitle(name ?? "")
  if (title) return title
  const [first, second] = changes.files.map(
    (file) => file.path.split("/").pop() || file.path,
  )
  if (!first) return "Changes from ctxpipe"
  const others =
    changes.files.length > 2
      ? ` and ${changes.files.length - 1} other files`
      : second
        ? ` and ${second}`
        : ""
  return cleanTitle(`Update ${first}${others}`)
}

/**
 * The pull request body, plain markdown written once at Create PR: the commit
 * subjects and a link to the conversation. GitHub's Files tab lists the
 * files. Credentials are masked.
 */
export function pullRequestBody(input: {
  changes: BranchChanges
  conversationUrl: string | null
}): string {
  const subjects = [
    ...new Set(
      input.changes.commits
        .map((message) => message.split(/\r?\n/)[0]?.trim() ?? "")
        .filter(Boolean),
    ),
  ]
  const lines = subjects.length
    ? subjects.map((subject) => `- ${subject}`)
    : ["Changes made in a ctxpipe conversation."]
  if (input.conversationUrl)
    lines.push(
      "",
      `[Open the conversation in ctxpipe](${input.conversationUrl})`,
    )
  return maskCredentials(lines.join("\n"))
}
