import { createHash } from "node:crypto"
import {
  connectorAssetCommitFile,
  connectorCommitFileUnchanged,
  createConnectorAssetBudget,
  downloadConnectorAsset,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import {
  applyLinearAssetRewrites,
  isLinearGithubReferenceAttachment,
  isLinearUploadUrl,
  type LinearAttachmentMetadata,
  type LinearIssueForMirror,
  type LinearMirrorFile,
  type LinearResolvedAsset,
  linearEntityMarkdownPath,
  linearIssueMarkdownPath,
  renderLinearEntity,
  renderLinearIssue,
} from "./converter.js"
import { scanLinearMarkdownImages } from "./markdown-images.js"

export function omitUnchangedLinearBinaryFiles<
  T extends { path: string; content: string; encoding?: "utf-8" | "base64" },
>(files: T[], existing: ReadonlyArray<{ path: string; sha: string }>): T[] {
  const shaByPath = new Map(existing.map((file) => [file.path, file.sha]))
  return files.filter((file) => {
    if (file.encoding !== "base64") return true
    return !connectorCommitFileUnchanged(file, shaByPath)
  })
}

export function linearManagedPathsForEntity(
  paths: string[],
  id: string,
): string[] {
  const markdownSuffix = `--${id}.md`
  const assetInfix = `--${id}/assets/`
  return paths.filter(
    (path) =>
      path.startsWith("linear/") &&
      (path.endsWith(markdownSuffix) || path.includes(assetInfix)),
  )
}

function isLinearTrustedAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === "uploads.linear.app" ||
    host.endsWith(".uploads.linear.app") ||
    host === "api.linear.app" ||
    host === "client-api.linear.app"
  )
}

function authenticatedHostsFor(url: string): string[] {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (!isLinearTrustedAssetHost(host)) return []
    return [
      ...new Set([
        host,
        "uploads.linear.app",
        "api.linear.app",
        "client-api.linear.app",
      ]),
    ]
  } catch {
    return []
  }
}

function shouldDownloadAttachment(
  attachment: LinearAttachmentMetadata,
): boolean {
  if (isLinearGithubReferenceAttachment(attachment)) return false
  if (isGithubPullOrCommitUrl(attachment.url)) return false
  if (isLinearUploadUrl(attachment.url)) return true
  const kind = attachment.sourceType?.toLowerCase()
  return kind === "upload" || kind === "file"
}

function isGithubPullOrCommitUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() !== "github.com") return false
    const parts = parsed.pathname.split("/").filter(Boolean)
    return parts.indexOf("pull") >= 2 || parts.indexOf("commit") >= 2
  } catch {
    return false
  }
}

function inlineSourceKey(url: string): string {
  return `src-${createHash("sha1").update(url).digest("hex").slice(0, 12)}`
}

function extractMarkdownImageUrls(markdown: string): string[] {
  return scanLinearMarkdownImages(markdown).map((image) => image.url)
}

function siblingAssetDir(markdownPath: string): {
  gitDir: string
  relativeDir: string
} {
  const stem = markdownPath.slice(0, -".md".length)
  const leaf = stem.slice(stem.lastIndexOf("/") + 1)
  return {
    gitDir: `${stem}/assets`,
    relativeDir: `${leaf}/assets`,
  }
}

export async function captureLinearEntityAssets(input: {
  markdownPath: string
  accessToken: string
  attachments: LinearAttachmentMetadata[]
  markdownSources: Array<string | null | undefined>
}): Promise<{
  files: CommitFile[]
  assets: LinearResolvedAsset[]
  rewriteMarkdown: (markdown: string | null | undefined) => string
}> {
  const budget = createConnectorAssetBudget()
  const { gitDir, relativeDir } = siblingAssetDir(input.markdownPath)
  const pending = new Map<string, { sourceKey: string; filename?: string }>()

  for (const attachment of input.attachments) {
    if (!shouldDownloadAttachment(attachment)) continue
    pending.set(attachment.url, {
      sourceKey: attachment.id,
      filename: attachment.title,
    })
  }

  for (const source of input.markdownSources) {
    if (!source) continue
    for (const url of extractMarkdownImageUrls(source)) {
      if (pending.has(url) || isGithubPullOrCommitUrl(url)) continue
      pending.set(url, { sourceKey: inlineSourceKey(url) })
    }
  }

  const assets: LinearResolvedAsset[] = []
  const files: CommitFile[] = []

  for (const [url, pendingAsset] of pending) {
    const authenticatedHosts = authenticatedHostsFor(url)
    const downloaded = await downloadConnectorAsset({
      url,
      budget,
      filename: pendingAsset.filename,
      headers:
        authenticatedHosts.length > 0
          ? { Authorization: `Bearer ${input.accessToken}` }
          : undefined,
      authenticatedHosts,
    })
    const filename =
      downloaded.status === "downloaded"
        ? downloaded.filename
        : pendingAsset.filename || "attachment"
    const relativePath = `${relativeDir}/${pendingAsset.sourceKey}--${filename}`
    const gitPath = `${gitDir}/${pendingAsset.sourceKey}--${filename}`
    if (downloaded.status === "downloaded") {
      const asset: LinearResolvedAsset = {
        sourceUrl: url,
        sourceKey: pendingAsset.sourceKey,
        relativePath,
        gitPath,
        status: "downloaded",
        filename: downloaded.filename,
        bytes: downloaded.bytes,
      }
      assets.push(asset)
      files.push(connectorAssetCommitFile(gitPath, downloaded.bytes))
      continue
    }
    assets.push({
      sourceUrl: url,
      sourceKey: pendingAsset.sourceKey,
      relativePath,
      gitPath,
      status: "stub",
      reason: downloaded.reason,
    })
  }

  return {
    files,
    assets,
    rewriteMarkdown: (markdown) => applyLinearAssetRewrites(markdown, assets),
  }
}

export async function linearIssueMirrorFiles(
  issue: LinearIssueForMirror,
  accessToken: string,
): Promise<LinearMirrorFile[]> {
  const captured = await captureLinearEntityAssets({
    markdownPath: linearIssueMarkdownPath(issue.identifier, issue.id),
    accessToken,
    attachments: issue.attachments,
    markdownSources: [issue.description, ...issue.comments.map((c) => c.body)],
  })
  return [renderLinearIssue(issue, captured.assets), ...captured.files]
}

export async function linearEntityMirrorFiles(
  input: Parameters<typeof renderLinearEntity>[0] & { accessToken: string },
): Promise<LinearMirrorFile[]> {
  const { accessToken, ...renderInput } = input
  const captured = await captureLinearEntityAssets({
    markdownPath: linearEntityMarkdownPath(
      renderInput.directory,
      renderInput.title,
      renderInput.id,
    ),
    accessToken,
    attachments: [],
    markdownSources: [
      renderInput.body,
      ...(renderInput.sections ?? []).map((section) => section.body),
    ],
  })
  return [renderLinearEntity(renderInput, captured.assets), ...captured.files]
}
