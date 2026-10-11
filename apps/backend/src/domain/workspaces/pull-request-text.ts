import { cleanTitle, isUnnamedConversation } from "./conversation-title.js"
import { maskCredentials } from "./mask-credentials.js"

/** What the session branch adds to the default branch, as GitHub compares them. */
export type BranchChanges = {
  /** Full commit messages, oldest first. */
  commits: string[]
  files: Array<{ path: string; status: string }>
}

const sectionStart = "<!-- ctxpipe:summary:start -->"
const sectionEnd = "<!-- ctxpipe:summary:end -->"

function fileName(path: string): string {
  return path.split("/").pop() || path
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
  const [first, second] = changes.files.map((file) => fileName(file.path))
  if (!first) return "Changes from ctx|"
  if (!second) return cleanTitle(`Update ${first}`)
  if (changes.files.length === 2)
    return cleanTitle(`Update ${first} and ${second}`)
  return cleanTitle(
    `Update ${first} and ${changes.files.length - 1} other files`,
  )
}

/**
 * The pull request body, plain markdown in a ctx| section: the commit
 * subjects, the changed files (at most 50) and a link to the conversation.
 * Credentials are masked.
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
  const shown = input.changes.files.slice(0, 50)
  const hidden = input.changes.files.length - shown.length
  const lines = [sectionStart, "## Summary", ""]
  if (subjects.length) lines.push(...subjects.map((subject) => `- ${subject}`))
  else lines.push("Changes made in a ctx| conversation.")
  if (shown.length) {
    lines.push("", "## Changed files", "")
    lines.push(...shown.map((file) => `- \`${file.path}\` (${file.status})`))
    if (hidden > 0) lines.push(`- ${hidden} more files`)
  }
  if (input.conversationUrl)
    lines.push("", `[Open the conversation in ctx|](${input.conversationUrl})`)
  lines.push(sectionEnd)
  return maskCredentials(lines.join("\n"))
}

/**
 * The body after a later push: an empty body gets the generated body, and the
 * ctx| section is replaced while the text around it stays. `null`: leave the
 * body as it is, because a person wrote it without the section or it is
 * already current.
 */
export function refreshedPullRequestBody(
  current: string | null | undefined,
  generated: string,
): string | null {
  if (!current?.trim()) return generated
  const start = current.indexOf(sectionStart)
  const end = current.indexOf(sectionEnd, start)
  if (start < 0 || end < 0) return null
  const refreshed =
    current.slice(0, start) + generated + current.slice(end + sectionEnd.length)
  return refreshed === current ? null : refreshed
}
