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
  teamKey?: string | null
  teamName?: string | null
  projectId?: string | null
  projectName?: string | null
  cycleId?: string | null
  cycleName?: string | null
  assigneeId?: string | null
  assignee?: string | null
  creatorId?: string | null
  creator?: string | null
  labels: Array<{ id: string; name: string }>
  createdAt: Date
  updatedAt: Date
  comments: Array<{
    id: string
    body: string
    userId?: string | null
    userName?: string | null
    createdAt: Date
    updatedAt: Date
  }>
  attachments: LinearAttachmentMetadata[]
}

const LINEAR_UPLOAD_HOST = /(^|\.)uploads\.linear\.app$/i

function stableSlug(title: string, id: string): string {
  const readable = slugify(title).slice(0, 80) || "untitled"
  return `${readable}--${id}`
}

function frontmatter(metadata: Record<string, unknown>): string {
  return `---\n${stringify(metadata).trimEnd()}\n---`
}

function isLinearUploadUrl(url: string): boolean {
  try {
    return LINEAR_UPLOAD_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Rewrite auth-gated Linear upload URLs so GitHub/markdown viewers do not show broken images. */
export function rewriteLinearPrivateMedia(
  markdown: string | null | undefined,
): string {
  if (!markdown) return ""
  return markdown
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
      (full, alt: string, url: string) => {
        if (!isLinearUploadUrl(url)) return full
        const label = alt.trim() || "image"
        return `[image: ${label} — view in Linear]`
      },
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (full, label: string, url: string) => {
        if (!isLinearUploadUrl(url)) return full
        return `[${label} — view in Linear]`
      },
    )
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
    .map((attachment) => {
      const privateUpload = isLinearUploadUrl(attachment.url)
      return {
        id: attachment.id,
        title: attachment.title,
        url: privateUpload ? null : attachment.url,
        sourceType: attachment.sourceType ?? null,
        ...(privateUpload
          ? {
              note: "Linear-hosted file omitted; open the issue in Linear to view it.",
            }
          : {}),
      }
    })
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
      team: issue.teamName ?? issue.teamKey ?? null,
      teamKey: issue.teamKey ?? null,
      teamId: issue.teamId ?? null,
      project: issue.projectName ?? null,
      projectId: issue.projectId ?? null,
      cycle: issue.cycleName ?? null,
      cycleId: issue.cycleId ?? null,
      assignee: issue.assignee ?? null,
      assigneeId: issue.assigneeId ?? null,
      creator: issue.creator ?? null,
      creatorId: issue.creatorId ?? null,
      labels: issue.labels.map((label) => label.name),
      labelIds: issue.labels.map((label) => label.id),
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      githubReferences,
      attachments: attachmentMetadata,
    }),
    `# ${issue.identifier}: ${issue.title}`,
    rewriteLinearPrivateMedia(issue.description)?.trim() ||
      "_No description._",
  ]
  if (issue.comments.length > 0) {
    sections.push(
      "## Comments",
      ...issue.comments.map((comment) => {
        const author = comment.userName?.trim() || comment.userId || "unknown"
        return `### ${comment.createdAt.toISOString()} · ${author}\n\n${rewriteLinearPrivateMedia(comment.body)}`
      }),
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
    rewriteLinearPrivateMedia(input.body)?.trim() || "_No description._",
    ...(input.sections ?? []).flatMap((section) => [
      `## ${section.heading}`,
      rewriteLinearPrivateMedia(section.body),
    ]),
  ]
  return {
    path: `linear/${input.directory}/${stableSlug(input.title, input.id)}.md`,
    content: `${content.join("\n\n").trim()}\n`,
  }
}
