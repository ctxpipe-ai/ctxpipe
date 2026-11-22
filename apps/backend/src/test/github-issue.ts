import { renderGithubIssue } from "../services/github/issue-mirror/converter.js"

/** A GitHub issue mirror file of acme/shop, as the issue sync writes it. */
export function shopIssue(input: {
  number?: number
  title: string
  body: string
  labels?: string[]
}) {
  const number = input.number ?? 1
  return renderGithubIssue({
    id: `I_${number}`,
    number,
    repository: "acme/shop",
    url: `https://github.com/acme/shop/issues/${number}`,
    title: input.title,
    body: input.body,
    state: "open",
    stateReason: null,
    author: { login: "dev", type: "human" },
    labels: input.labels ?? [],
    assignees: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    closedAt: null,
    comments: [],
    commentsTotal: 0,
    closedBy: [],
  })
}
