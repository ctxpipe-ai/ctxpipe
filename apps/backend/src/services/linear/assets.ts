import { createHash } from "node:crypto"
import type { ConnectorAssetBytePool } from "../connectors/assets.js"
import {
  CONNECTOR_ENTITY_MAX_ASSETS,
  CONNECTOR_ENTITY_MAX_BYTES,
  canonicalConnectorAssetUrl,
  connectorAssetCommitFile,
  connectorBlobUnchanged,
  connectorCommitFileUnchanged,
  consumeConnectorAssetBytePool,
  createConnectorAssetBudget,
  createConnectorAssetBytePool,
  downloadConnectorAsset,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import {
  applyLinearAssetRewrites,
  isLinearGithubPullOrCommitUrl,
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
import {
  scanLinearMarkdownImages,
  scanLinearMarkdownLinks,
} from "./markdown-images.js"

export function omitUnchangedLinearFiles<
  T extends { path: string; content: string; encoding?: "utf-8" | "base64" },
>(files: T[], existing: ReadonlyArray<{ path: string; sha: string }>): T[] {
  const shaByPath = new Map(existing.map((file) => [file.path, file.sha]))
  return files.filter((file) => !connectorCommitFileUnchanged(file, shaByPath))
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

export function linearMatchingExistingAssetPaths(
  paths: Iterable<string>,
  preservation: string,
): string[] {
  const marker = "/assets/"
  const markerIndex = preservation.indexOf(marker)
  if (!preservation.endsWith("--") || markerIndex < 0) return []
  const ownerSegment = preservation.slice(0, markerIndex).split("/").at(-1)
  const ownerDirectory = preservation.slice(
    0,
    preservation.slice(0, markerIndex).lastIndexOf("/") + 1,
  )
  const ownerSeparator = ownerSegment?.lastIndexOf("--") ?? -1
  if (!ownerSegment || ownerSeparator < 0) return []
  const ownerId = ownerSegment.slice(ownerSeparator + 2).toLowerCase()
  const sourcePrefix = preservation.slice(markerIndex + marker.length)
  return [...paths].filter((path) => {
    const existingMarkerIndex = path.indexOf(marker)
    if (!path.startsWith("linear/") || existingMarkerIndex < 0) return false
    const existingOwner = path.slice(0, existingMarkerIndex).split("/").at(-1)
    const existingOwnerDirectory = path.slice(
      0,
      path.slice(0, existingMarkerIndex).lastIndexOf("/") + 1,
    )
    const existingSeparator = existingOwner?.lastIndexOf("--") ?? -1
    if (!existingOwner || existingSeparator < 0) return false
    const existingOwnerId = existingOwner
      .slice(existingSeparator + 2)
      .toLowerCase()
    const leaf = path.slice(existingMarkerIndex + marker.length)
    return (
      existingOwnerDirectory === ownerDirectory &&
      existingOwnerId === ownerId &&
      leaf.startsWith(sourcePrefix)
    )
  })
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
  if (isLinearGithubPullOrCommitUrl(attachment.url)) return false
  if (isLinearUploadUrl(attachment.url)) return true
  const kind = attachment.sourceType?.toLowerCase()
  return kind === "upload" || kind === "file"
}

function inlineSourceKey(url: string): string {
  return `src-${createHash("sha1")
    .update(canonicalLinearAssetUrl(url))
    .digest("hex")
    .slice(0, 12)}`
}

function canonicalLinearAssetUrl(url: string): string {
  return canonicalConnectorAssetUrl(url, {
    stripGenericCredentials: true,
  })
}

function extractMarkdownAssetUrls(markdown: string): string[] {
  return [
    ...new Set([
      ...scanLinearMarkdownImages(markdown).map((image) => image.url),
      ...scanLinearMarkdownLinks(markdown)
        .filter((link) => isLinearUploadUrl(link.url))
        .map((link) => link.url),
    ]),
  ]
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
  bytePool?: ConnectorAssetBytePool
  existingShaByPath?: ReadonlyMap<string, string>
}): Promise<{
  files: CommitFile[]
  assets: LinearResolvedAsset[]
  preservePathPrefixes: string[]
  rewriteMarkdown: (markdown: string | null | undefined) => string
}> {
  const budget = createConnectorAssetBudget()
  const bytePool =
    input.bytePool ??
    createConnectorAssetBytePool(
      CONNECTOR_ENTITY_MAX_BYTES,
      CONNECTOR_ENTITY_MAX_ASSETS,
    )
  const { gitDir, relativeDir } = siblingAssetDir(input.markdownPath)
  const pending = new Map<
    string,
    {
      url: string
      sourceUrls: string[]
      sourceKey: string
      filename?: string
    }
  >()
  const pendingKeyByUrlIdentity = new Map<string, string>()

  for (const attachment of input.attachments) {
    if (!shouldDownloadAttachment(attachment)) continue
    pending.set(attachment.id, {
      url: attachment.url,
      sourceUrls: [attachment.url],
      sourceKey: attachment.id,
      filename: attachment.title,
    })
    const identity = canonicalLinearAssetUrl(attachment.url)
    if (!pendingKeyByUrlIdentity.has(identity)) {
      pendingKeyByUrlIdentity.set(identity, attachment.id)
    }
  }

  for (const source of input.markdownSources) {
    if (!source) continue
    for (const url of extractMarkdownAssetUrls(source)) {
      if (isLinearGithubPullOrCommitUrl(url)) continue
      const identity = canonicalLinearAssetUrl(url)
      const existingKey = pendingKeyByUrlIdentity.get(identity)
      if (existingKey) {
        const existing = pending.get(existingKey)
        if (existing && !existing.sourceUrls.includes(url)) {
          existing.sourceUrls.push(url)
        }
        continue
      }
      const sourceKey = inlineSourceKey(url)
      pending.set(sourceKey, { url, sourceUrls: [url], sourceKey })
      pendingKeyByUrlIdentity.set(identity, sourceKey)
    }
  }

  const assets: LinearResolvedAsset[] = []
  const files: CommitFile[] = []
  const preservePathPrefixes: string[] = []
  const downloadedByUrl = new Map<
    string,
    Awaited<ReturnType<typeof downloadConnectorAsset>>
  >()
  const markdownDirectory = input.markdownPath.slice(
    0,
    input.markdownPath.lastIndexOf("/") + 1,
  )
  const preservedAssetFor = (sourceKey: string) => {
    if (!input.existingShaByPath) return undefined
    const gitPath = linearMatchingExistingAssetPaths(
      input.existingShaByPath.keys(),
      `${gitDir}/${sourceKey}--`,
    ).sort()[0]
    if (!gitPath?.startsWith(markdownDirectory)) return undefined
    const leaf = gitPath.slice(gitPath.lastIndexOf("/") + 1)
    return {
      filename: leaf.slice(`${sourceKey}--`.length) || "attachment",
      gitPath,
      relativePath: gitPath.slice(markdownDirectory.length),
    }
  }
  let remainingDeclaredAssets = CONNECTOR_ENTITY_MAX_ASSETS

  for (const pendingAsset of pending.values()) {
    const { url } = pendingAsset
    let downloaded: Awaited<ReturnType<typeof downloadConnectorAsset>>
    if (remainingDeclaredAssets <= 0) {
      downloaded = { status: "stub", reason: "entity_limit" }
    } else {
      remainingDeclaredAssets -= 1
      const urlIdentity = canonicalLinearAssetUrl(url)
      const cached = downloadedByUrl.get(urlIdentity)
      if (cached) {
        downloaded = cached
      } else {
        const authenticatedHosts = authenticatedHostsFor(url)
        downloaded = await downloadConnectorAsset({
          url,
          budget,
          filename: pendingAsset.filename,
          headers:
            authenticatedHosts.length > 0
              ? { Authorization: `Bearer ${input.accessToken}` }
              : undefined,
          authenticatedHosts,
        })
        downloadedByUrl.set(urlIdentity, downloaded)
      }
    }
    const filename =
      downloaded.status === "downloaded"
        ? downloaded.filename
        : pendingAsset.filename || "attachment"
    const relativePath = `${relativeDir}/${pendingAsset.sourceKey}--${filename}`
    const gitPath = `${gitDir}/${pendingAsset.sourceKey}--${filename}`
    if (
      downloaded.status === "downloaded" &&
      input.existingShaByPath &&
      connectorBlobUnchanged(gitPath, downloaded.bytes, input.existingShaByPath)
    ) {
      for (const sourceUrl of pendingAsset.sourceUrls) {
        assets.push({
          sourceUrl,
          sourceKey: pendingAsset.sourceKey,
          relativePath,
          gitPath,
          status: "downloaded",
          filename: downloaded.filename,
        })
      }
      preservePathPrefixes.push(gitPath)
      continue
    }
    if (
      downloaded.status === "downloaded" &&
      !consumeConnectorAssetBytePool(bytePool, downloaded.bytes.byteLength)
    ) {
      downloaded = { status: "stub", reason: "entity_limit" }
    }
    if (downloaded.status === "downloaded") {
      for (const sourceUrl of pendingAsset.sourceUrls) {
        assets.push({
          sourceUrl,
          sourceKey: pendingAsset.sourceKey,
          relativePath,
          gitPath,
          status: "downloaded",
          filename: downloaded.filename,
        })
      }
      files.push(connectorAssetCommitFile(gitPath, downloaded.bytes))
      continue
    }
    const preserved =
      downloaded.reason === "download_failed" ||
      downloaded.reason === "entity_limit"
        ? preservedAssetFor(pendingAsset.sourceKey)
        : undefined
    if (preserved) {
      for (const sourceUrl of pendingAsset.sourceUrls) {
        assets.push({
          sourceUrl,
          sourceKey: pendingAsset.sourceKey,
          relativePath: preserved.relativePath,
          gitPath: preserved.gitPath,
          status: "downloaded",
          filename: preserved.filename,
        })
      }
      preservePathPrefixes.push(preserved.gitPath)
      continue
    }
    for (const sourceUrl of pendingAsset.sourceUrls) {
      assets.push({
        sourceUrl,
        sourceKey: pendingAsset.sourceKey,
        relativePath,
        gitPath,
        status: "stub",
        reason: downloaded.reason,
      })
    }
    if (
      downloaded.reason === "download_failed" ||
      downloaded.reason === "entity_limit"
    ) {
      preservePathPrefixes.push(`${gitDir}/${pendingAsset.sourceKey}--`)
    }
  }

  return {
    files,
    assets,
    preservePathPrefixes,
    rewriteMarkdown: (markdown) => applyLinearAssetRewrites(markdown, assets),
  }
}

export async function linearIssueMirrorFiles(
  issue: LinearIssueForMirror,
  accessToken: string,
  options?: {
    onPreservePathPrefix?: (prefix: string) => void
    bytePool?: ConnectorAssetBytePool
    existingShaByPath?: ReadonlyMap<string, string>
  },
): Promise<LinearMirrorFile[]> {
  const captured = await captureLinearEntityAssets({
    markdownPath: linearIssueMarkdownPath(issue.identifier, issue.id),
    accessToken,
    attachments: issue.attachments,
    markdownSources: [issue.description, ...issue.comments.map((c) => c.body)],
    bytePool: options?.bytePool,
    existingShaByPath: options?.existingShaByPath,
  })
  for (const prefix of captured.preservePathPrefixes) {
    options?.onPreservePathPrefix?.(prefix)
  }
  return [renderLinearIssue(issue, captured.assets), ...captured.files]
}

export async function linearEntityMirrorFiles(
  input: Parameters<typeof renderLinearEntity>[0] & {
    accessToken: string
    onPreservePathPrefix?: (prefix: string) => void
    bytePool?: ConnectorAssetBytePool
    existingShaByPath?: ReadonlyMap<string, string>
  },
): Promise<LinearMirrorFile[]> {
  const {
    accessToken,
    onPreservePathPrefix,
    bytePool,
    existingShaByPath,
    ...renderInput
  } = input
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
    bytePool,
    existingShaByPath,
  })
  for (const prefix of captured.preservePathPrefixes) {
    onPreservePathPrefix?.(prefix)
  }
  return [renderLinearEntity(renderInput, captured.assets), ...captured.files]
}
