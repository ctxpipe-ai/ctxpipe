import { stampSources } from "../domain/workspace-sources/stamp-sources.js"
import { renderGithubIssue } from "../services/github/issue-mirror/converter.js"

/** The source file of acme/shop in a Workspace. */
export const SHOP_SOURCE_PATH = "sources/github/acme/shop.md"

/**
 * A GitHub issue mirror file of acme/shop, as the issue sync writes it: with
 * the source of acme/shop in its `sources`.
 */
export function shopIssue(input: {
  number?: number
  title: string
  body: string
  labels?: string[]
  createdAt?: string
  /** The time of the close and the pull requests that closed the issue. */
  closed?: { at: string; by: string[] }
}) {
  const number = input.number ?? 1
  const file = renderGithubIssue({
    id: `I_${number}`,
    number,
    repository: "acme/shop",
    url: `https://github.com/acme/shop/issues/${number}`,
    title: input.title,
    body: input.body,
    state: input.closed ? "closed" : "open",
    stateReason: null,
    author: { login: "dev", type: "human" },
    labels: input.labels ?? [],
    assignees: [],
    createdAt: input.createdAt ?? "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    closedAt: input.closed?.at ?? null,
    comments: [],
    commentsTotal: 0,
    closedBy: input.closed?.by ?? [],
  })
  return { ...file, content: stampSources(file.content, [SHOP_SOURCE_PATH]) }
}
