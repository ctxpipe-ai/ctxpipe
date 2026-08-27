import slugify from "@sindresorhus/slugify"
import { stringify } from "yaml"
import { isConnectorAssetCredentialUrl } from "../connectors/assets.js"
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
    const candidate = url.trim().startsWith("//") ? `https:${url.trim()}` : url
    return LINEAR_UPLOAD_HOST.test(new URL(candidate).hostname)
  } catch {
    return false
  }
}

function isLinearPrivateAssetUrl(url: string): boolean {
  return (
    isLinearUploadUrl(url) ||
    isConnectorAssetCredentialUrl(url, {
      includeGenericCredentials: true,
    })
  )
}

function markdownLabel(value: string, fallback: string): string {
  return (value.trim() || fallback)
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/[\r\n]+/g, " ")
}

function rewriteLinearUploadLinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]]+)\]\(((?:https?:)?\/\/[^)\s]+)\)/g,
    (full, label: string, url: string) => {
      if (!isLinearPrivateAssetUrl(url)) return full
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
      isLinearPrivateAssetUrl(image.url)
        ? `[image: ${markdownLabel(image.alt, "image")} — view in Linear]`
        : image.source,
    (link) => {
      if (!isLinearPrivateAssetUrl(link.url)) return link.source
      if (link.containsImage && link.content) return link.content
      return `[${markdownLabel(link.label, "link")} — view in Linear]`
    },
  )
  return rewriteLinearUploadLinks(withoutPrivateImages).replace(
    /(?:https?:)?\/\/[^\s<>"']+/gi,
    (rawUrl) => {
      const url = rawUrl.replace(/[\])},.;:!?]+$/, "")
      if (!isLinearPrivateAssetUrl(url)) return rawUrl
      return `[Linear attachment — view in Linear]${rawUrl.slice(url.length)}`
    },
  )
}

function linearAssetsByUrl(
  assets: readonly LinearResolvedAsset[],
): Map<string, LinearResolvedAsset> {
  const byUrl = new Map<string, LinearResolvedAsset>()
  for (const asset of assets) {
    const existing = byUrl.get(asset.sourceUrl)
    if (
      !existing ||
      (existing.status === "stub" && asset.status === "downloaded")
    ) {
      byUrl.set(asset.sourceUrl, asset)
    }
  }
  return byUrl
}

export function applyLinearAssetRewrites(
  markdown: string | null | undefined,
  assets: readonly LinearResolvedAsset[] = [],
): string {
  if (!markdown) return ""
  const assetsByUrl = linearAssetsByUrl(assets)
  const rewritten = rewriteLinearMarkdownImages(
    markdown,
    (image) => {
      const asset = assetsByUrl.get(image.url)
      const label = markdownLabel(image.alt, "image")
      if (asset?.status === "downloaded") {
        return `![${label}](${asset.relativePath})`
      }
      if (asset?.status === "stub") {
        return isLinearUploadUrl(image.url)
          ? `[image: ${label} — view in Linear]`
          : `[image: ${label} — unavailable]`
      }
      return image.source
    },
    (link) => {
      const asset = assetsByUrl.get(link.url)
      const label = markdownLabel(link.label, "link")
      if (
        link.containsImage &&
        link.content &&
        isLinearPrivateAssetUrl(link.url)
      ) {
        return link.content
      }
      if (asset?.status === "downloaded") {
        return `[${label}](${asset.relativePath})`
      }
      if (asset?.status === "stub") {
        return isLinearUploadUrl(link.url)
          ? `[${label} — view in Linear]`
          : `[${label} — unavailable]`
      }
      return link.source
    },
  )
  return rewriteLinearPrivateMedia(rewritten)
}

function linearGithubReferenceKind(
  rawUrl: string,
): "pull_request" | "commit" | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.hostname.toLowerCase() !== "github.com") return undefined
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts[2] === "pull" && parts[3] !== undefined && /^\d+$/.test(parts[3])) {
    return "pull_request"
  }
  if (
    parts[2] === "commit" &&
    parts[3] !== undefined &&
    /^[0-9a-f]{7,40}$/i.test(parts[3])
  ) {
    return "commit"
  }
  return undefined
}

export function isLinearGithubPullOrCommitUrl(url: string): boolean {
  return linearGithubReferenceKind(url) !== undefined
}

function githubReference(attachment: LinearAttachmentMetadata):
  | {
      kind: "pull_request" | "commit"
      url: string
      title: string
      state?: string
    }
  | undefined {
  const kind = linearGithubReferenceKind(attachment.url)
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
    resolved?.status === "stub" || isLinearPrivateAssetUrl(attachment.url)
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
  const assetsByUrl = linearAssetsByUrl(assets)
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
