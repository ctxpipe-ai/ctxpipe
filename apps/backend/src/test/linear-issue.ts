import { renderLinearIssue } from "../services/linear/converter.js"

/**
 * A Linear issue mirror file, as the Linear sync writes it, with its status
 * dates and its GitHub pull request attachments (CTX-1526).
 */
export function linearIssueFile(input: {
  identifier: string
  completedAt?: string
  canceledAt?: string
  /** The GitHub pull requests that the issue has as attachments. */
  pulls?: Array<{ url: string; state: string }>
}) {
  return renderLinearIssue({
    id: `issue-${input.identifier}`,
    identifier: input.identifier,
    title: `Issue ${input.identifier}`,
    url: `https://linear.app/acme/issue/${input.identifier}/issue`,
    priorityLabel: "No priority",
    teamKey: input.identifier.split("-")[0] ?? "",
    labels: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    completedAt: input.completedAt ? new Date(input.completedAt) : null,
    canceledAt: input.canceledAt ? new Date(input.canceledAt) : null,
    comments: [],
    attachments: (input.pulls ?? []).map((pull, index) => ({
      id: `attachment-${index}`,
      title: pull.url,
      url: pull.url,
      sourceType: "github",
      metadata: { state: pull.state },
    })),
  })
}
