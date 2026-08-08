import slugify from "@sindresorhus/slugify"
import { stringify } from "yaml"

export type LinearMirrorFile = {
  path: string
  content: string
}

export type LinearAttachmentMetadata = {
  id: string
  title: string
  url: string
  sourceType?: string | null
  metadata?: Record<string, unknown> | null
}

export type LinearIssueForMirror = {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  priorityLabel: string
  state?: string | null
  teamId?: string | null
  projectId?: string | null
  cycleId?: string | null
  assigneeId?: string | null
  creatorId?: string | null
  labelIds: string[]
  createdAt: Date
  updatedAt: Date
  comments: Array<{
    id: string
    body: string
    userId?: string | null
    createdAt: Date
    updatedAt: Date
  }>
  attachments: LinearAttachmentMetadata[]
}

function stableSlug(title: string, id: string): string {
  const readable = slugify(title).slice(0, 80) || "untitled"
  return `${readable}--${id}`
}

function frontmatter(metadata: Record<string, unknown>): string {
  return `---\n${stringify(metadata).trimEnd()}\n---`
}

function githubReference(attachment: LinearAttachmentMetadata):
  | {
      kind: "pull_request" | "commit"
      url: string
      title: string
      state?: string
    }
  | undefined {
  let url: URL
  try {
    url = new URL(attachment.url)
  } catch {
    return undefined
  }
  if (url.hostname.toLowerCase() !== "github.com") return undefined
  const parts = url.pathname.split("/").filter(Boolean)
  const pullIndex = parts.indexOf("pull")
  const commitIndex = parts.indexOf("commit")
  const kind =
    pullIndex >= 2
      ? ("pull_request" as const)
      : commitIndex >= 2
        ? ("commit" as const)
        : undefined
  if (!kind) return undefined
  const state =
    attachment.metadata &&
    typeof attachment.metadata.state === "string" &&
    attachment.metadata.state.length > 0
      ? attachment.metadata.state
      : undefined
  return { kind, url: attachment.url, title: attachment.title, state }
}

export function renderLinearIssue(
  issue: LinearIssueForMirror,
): LinearMirrorFile {
  const githubReferences = issue.attachments
    .map(githubReference)
    .filter((reference) => reference !== undefined)
  const attachmentMetadata = issue.attachments
    .filter((attachment) => !githubReference(attachment))
    .map((attachment) => ({
      id: attachment.id,
      title: attachment.title,
      url: attachment.url,
      sourceType: attachment.sourceType ?? null,
    }))
  const sections = [
    frontmatter({
      source: "linear",
      type: "issue",
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state ?? null,
      priority: issue.priorityLabel,
      teamId: issue.teamId ?? null,
      projectId: issue.projectId ?? null,
      cycleId: issue.cycleId ?? null,
      assigneeId: issue.assigneeId ?? null,
      creatorId: issue.creatorId ?? null,
      labelIds: issue.labelIds,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      githubReferences,
      attachments: attachmentMetadata,
    }),
    `# ${issue.identifier}: ${issue.title}`,
    issue.description?.trim() || "_No description._",
  ]
  if (issue.comments.length > 0) {
    sections.push(
      "## Comments",
      ...issue.comments.map(
        (comment) =>
          `### ${comment.createdAt.toISOString()}${comment.userId ? ` · ${comment.userId}` : ""}\n\n${comment.body}`,
      ),
    )
  }
  return {
    path: `linear/issues/${stableSlug(issue.identifier, issue.id)}.md`,
    content: `${sections.join("\n\n").trim()}\n`,
  }
}

export function renderLinearEntity(input: {
  directory:
    | "teams"
    | "projects"
    | "customer-requests"
    | "documents"
    | "initiatives"
    | "cycles"
    | "labels"
    | "users"
  type: string
  id: string
  title: string
  url?: string | null
  body?: string | null
  metadata?: Record<string, unknown>
  sections?: Array<{ heading: string; body: string }>
}): LinearMirrorFile {
  const content = [
    frontmatter({
      source: "linear",
      type: input.type,
      id: input.id,
      title: input.title,
      url: input.url ?? null,
      ...input.metadata,
    }),
    `# ${input.title}`,
    input.body?.trim() || "_No description._",
    ...(input.sections ?? []).flatMap((section) => [
      `## ${section.heading}`,
      section.body,
    ]),
  ]
  return {
    path: `linear/${input.directory}/${stableSlug(input.title, input.id)}.md`,
    content: `${content.join("\n\n").trim()}\n`,
  }
}
