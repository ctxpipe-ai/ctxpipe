import { stringify } from "yaml"
import {
  asString,
  asStringArray,
  excerptOf,
  splitFrontmatter,
} from "../../../graphs/codeIngestionGraph/nodes/connectorFrontmatter.js"
import type { CommitFile } from "../installation-write-client.js"
import type { GithubPrActor } from "../pull-request-mirror/types.js"
import type { GithubIssueSnapshot } from "./client.js"

export const GITHUB_ISSUES_PREFIX = "github/issues/"

function actorLine(actor: GithubPrActor): string {
  return actor.type === "bot" ? `${actor.login} (bot)` : actor.login
}

export function renderGithubIssue(issue: GithubIssueSnapshot): CommitFile {
  const metadata = {
    source: "github",
    type: "issue",
    id: issue.id,
    number: issue.number,
    repository: issue.repository,
    url: issue.url,
    title: issue.title,
    state: issue.state,
    stateReason: issue.stateReason,
    author: issue.author.login,
    authorType: issue.author.type,
    labels: issue.labels,
    assignees: issue.assignees,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    closedBy: issue.closedBy,
  }
  const sections = [
    `---\n${stringify(metadata).trimEnd()}\n---`,
    `# ${issue.title.trim() || "Untitled issue"}`,
    issue.body.trim() || "_No description._",
  ]
  if (issue.comments.length > 0) {
    sections.push(
      "## Comments",
      ...issue.comments.map(
        (comment) =>
          `### ${comment.createdAt} · ${actorLine(comment.author)}\n\n${comment.body}`,
      ),
    )
  }
  return {
    // GitHub never reuses or changes an issue number, so it is the stable id.
    path: `${GITHUB_ISSUES_PREFIX}${issue.repository}/${issue.number}.md`,
    content: `${sections.join("\n\n").trim()}\n`,
  }
}

export type ParsedGithubIssue = {
  number: number
  repository: string
  url: string
  title: string
  state: "open" | "closed"
  stateReason: string | null
  author: string | null
  labels: string[]
  assignees: string[]
  createdAt: string | null
  updatedAt: string | null
  closedAt: string | null
  /** Pull request URLs GitHub links as closing the issue. */
  closedBy: string[]
  /** Description text before the comments (≤ 2000 chars). */
  excerpt: string
}

/** Frontmatter written by {@link renderGithubIssue}. */
export function parseGithubIssueMarkdown(
  content: string,
): ParsedGithubIssue | null {
  const split = splitFrontmatter(content)
  if (!split) return null
  const { data, body } = split
  if (data.source !== "github" || data.type !== "issue") return null
  const repository = asString(data.repository)
  const url = asString(data.url)
  const title = asString(data.title)
  const state =
    data.state === "open" || data.state === "closed" ? data.state : null
  if (
    typeof data.number !== "number" ||
    !repository ||
    !url ||
    !title ||
    !state
  ) {
    return null
  }
  return {
    number: data.number,
    repository,
    url,
    title,
    state,
    stateReason: asString(data.stateReason),
    author: asString(data.author),
    labels: asStringArray(data.labels),
    assignees: asStringArray(data.assignees),
    createdAt: asString(data.createdAt),
    updatedAt: asString(data.updatedAt),
    closedAt: asString(data.closedAt),
    closedBy: asStringArray(data.closedBy),
    excerpt: excerptOf(body, /\n## Comments\b/),
  }
}
