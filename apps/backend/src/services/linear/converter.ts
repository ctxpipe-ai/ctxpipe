import slugify from "@sindresorhus/slugify"
import { stringify } from "yaml"
import { rewriteLinearMarkdownImages } from "./markdown-images.js"

export type LinearMirrorFile = {
  path: string
  content: string
  encoding?: "utf-8" | "base64"
}

export type LinearAttachmentMetadata = {
  id: string
  title: string
  url: string
  sourceType?: string | null
  metadata?: Record<string, unknown> | null
}

export type LinearResolvedAsset =
  | {
      sourceUrl: string
      sourceKey: string
      relativePath: string
      gitPath: string
      status: "downloaded"
      filename: string
    }
  | {
      sourceUrl: string
      sourceKey: string
      relativePath: string
      gitPath: string
      status: "stub"
      reason: string
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

export function linearIssueMarkdownPath(
  identifier: string,
  id: string,
): string {
  return `linear/issues/${stableSlug(identifier, id)}.md`
}

export function linearEntityMarkdownPath(
  directory: string,
  title: string,
  id: string,
): string {
  return `linear/${directory}/${stableSlug(title, id)}.md`
}

function frontmatter(metadata: Record<string, unknown>): string {
  return `---\n${stringify(metadata).trimEnd()}\n---`
}

export function isLinearUploadUrl(url: string): boolean {
  try {
    return LINEAR_UPLOAD_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function rewriteLinearUploadLinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (full, label: string, url: string) => {
      if (!isLinearUploadUrl(url)) return full
      return `[${label} — view in Linear]`
    },
  )
}

/** Rewrite auth-gated Linear upload URLs so GitHub/markdown viewers do not show broken images. */
export function rewriteLinearPrivateMedia(
  markdown: string | null | undefined,
): string {
  if (!markdown) return ""
  const withoutPrivateImages = rewriteLinearMarkdownImages(
    markdown,
    (image) =>
      isLinearUploadUrl(image.url)
        ? `[image: ${image.alt.trim() || "image"} — view in Linear]`
        : image.source,
    (link) =>
      isLinearUploadUrl(link.url)
        ? `[${link.label.trim() || "link"} — view in Linear]`
        : link.source,
  )
  return rewriteLinearUploadLinks(withoutPrivateImages)
}

export function applyLinearAssetRewrites(
  markdown: string | null | undefined,
  assets: readonly LinearResolvedAsset[] = [],
): string {
  if (!markdown) return ""
  const assetsByUrl = new Map(assets.map((asset) => [asset.sourceUrl, asset]))
  const rewritten = rewriteLinearMarkdownImages(
    markdown,
    (image) => {
      const asset = assetsByUrl.get(image.url)
      if (asset?.status === "downloaded") {
        return `![${image.alt}](${asset.relativePath})`
      }
      if (asset?.status === "stub") {
        return isLinearUploadUrl(image.url)
          ? `[image: ${image.alt.trim() || "image"} — view in Linear]`
          : `[image: ${image.alt.trim() || "image"} — unavailable]`
      }
      return image.source
    },
    (link) => {
      const asset = assetsByUrl.get(link.url)
      if (asset?.status === "downloaded") {
        return `[${link.label}](${asset.relativePath})`
      }
      if (asset?.status === "stub") {
        return isLinearUploadUrl(link.url)
          ? `[${link.label.trim() || "link"} — view in Linear]`
          : `[${link.label.trim() || "link"} — unavailable]`
      }
      return link.source
    },
  )
  return rewriteLinearPrivateMedia(rewritten)
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

export function isLinearGithubReferenceAttachment(
  attachment: LinearAttachmentMetadata,
): boolean {
  return githubReference(attachment) !== undefined
}

function attachmentFrontmatter(
  attachment: LinearAttachmentMetadata,
  assetsByKey: Map<string, LinearResolvedAsset>,
  assetsByUrl: Map<string, LinearResolvedAsset>,
): Record<string, unknown> {
  const resolved =
    assetsByKey.get(attachment.id) ?? assetsByUrl.get(attachment.url)
  if (resolved?.status === "downloaded") {
    return {
      id: attachment.id,
      title: attachment.title,
      path: resolved.relativePath,
      sourceType: attachment.sourceType ?? null,
    }
  }
  const unavailableFile =
    resolved?.status === "stub" || isLinearUploadUrl(attachment.url)
  return {
    id: attachment.id,
    title: attachment.title,
    url: unavailableFile ? null : attachment.url,
    sourceType: attachment.sourceType ?? null,
    ...(unavailableFile
      ? {
          note: "File omitted; open the issue in Linear to view it.",
        }
      : {}),
  }
}

export function renderLinearIssue(
  issue: LinearIssueForMirror,
  assets: readonly LinearResolvedAsset[] = [],
): LinearMirrorFile {
  const assetsByUrl = new Map(assets.map((asset) => [asset.sourceUrl, asset]))
  const assetsByKey = new Map(assets.map((asset) => [asset.sourceKey, asset]))
  const githubReferences = issue.attachments
    .map(githubReference)
    .filter((reference) => reference !== undefined)
  const attachmentMetadata = issue.attachments
    .filter((attachment) => !githubReference(attachment))
    .map((attachment) =>
      attachmentFrontmatter(attachment, assetsByKey, assetsByUrl),
    )
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
    applyLinearAssetRewrites(issue.description, assets).trim() ||
      "_No description._",
  ]
  if (issue.comments.length > 0) {
    sections.push(
      "## Comments",
      ...issue.comments.map((comment) => {
        const author = comment.userName?.trim() || comment.userId || "unknown"
        return `### ${comment.createdAt.toISOString()} · ${author}\n\n${applyLinearAssetRewrites(comment.body, assets)}`
      }),
    )
  }
  return {
    path: linearIssueMarkdownPath(issue.identifier, issue.id),
    content: `${sections.join("\n\n").trim()}\n`,
  }
}

export function renderLinearEntity(
  input: {
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
  },
  assets: readonly LinearResolvedAsset[] = [],
): LinearMirrorFile {
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
    applyLinearAssetRewrites(input.body, assets).trim() || "_No description._",
    ...(input.sections ?? []).flatMap((section) => [
      `## ${section.heading}`,
      applyLinearAssetRewrites(section.body, assets),
    ]),
  ]
  return {
    path: linearEntityMarkdownPath(input.directory, input.title, input.id),
    content: `${content.join("\n\n").trim()}\n`,
  }
}
