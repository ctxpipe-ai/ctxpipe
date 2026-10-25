import { stringify } from "yaml"

import { actorLine, splitRepository } from "../github-mirror.js"
import type { GithubIssueSnapshot } from "./client.js"

export const GITHUB_ISSUES_PREFIX = "github/issues/"

/** GitHub never reuses or changes an issue number, so it is the stable id. */
export function githubIssueMarkdownPath(
  repository: string,
  number: number,
): string {
  const { owner, repo } = splitRepository(repository)
  return `${GITHUB_ISSUES_PREFIX}${owner}/${repo}/${number}.md`
}

export function renderGithubIssue(issue: GithubIssueSnapshot): {
  path: string
  content: string
} {
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
  // In the body, so that hydrate links the issue to each mirrored pull request.
  if (issue.closedBy.length > 0)
    sections.push(
      "## Closed by",
      issue.closedBy.map((url) => `- ${url}`).join("\n"),
    )
  if (issue.comments.length > 0) {
    const dropped = issue.commentsTotal - issue.comments.length
    sections.push("## Comments")
    if (dropped > 0)
      sections.push(
        `_${dropped} older ${dropped === 1 ? "comment is" : "comments are"} not mirrored. See the issue on GitHub: ${issue.url}_`,
      )
    sections.push(
      ...issue.comments.map(
        (comment) =>
          `### ${comment.createdAt} · ${actorLine(comment.author)}\n\n${comment.body}`,
      ),
    )
  }
  return {
    path: githubIssueMarkdownPath(issue.repository, issue.number),
    content: `${sections.join("\n\n").trim()}\n`,
  }
}
