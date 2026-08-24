import { posix } from "node:path"
import { log } from "../../observability/logger.js"
import {
  type ConnectorAssetDownloadResult,
  connectorAssetCommitFile,
  connectorCommitFileUnchanged,
  createConnectorAssetBudget,
  downloadConnectorAsset,
  gitBlobSha,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import type { NotionBlock, NotionPage } from "./client.js"
import type { NotionAssetMap, NotionCapturedAsset } from "./converter.js"
import {
  getNotionDatabaseRowPath,
  getNotionPagePath,
  notionFilesPropertyAssetKeys,
  toNotionDatabaseFiles,
  toNotionMarkdownFile,
} from "./converter.js"

type DownloadAsset = (input: {
  url: string
  budget: ReturnType<typeof createConnectorAssetBudget>
  filename?: string
  headers?: Record<string, string>
  authenticatedHosts?: readonly string[]
}) => Promise<ConnectorAssetDownloadResult>

type NotionMediaRef = {
  key: string
  pathKey: string
  assetLeaf?: string
  contentIdentity?: boolean
  kind: "image" | "file"
  url?: string
  name?: string
  caption: string
}

function richTextPlainText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((part) =>
      part &&
      typeof part === "object" &&
      "plain_text" in part &&
      typeof part.plain_text === "string"
        ? part.plain_text
        : "",
    )
    .join("")
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const leaf = decodeURIComponent(
      new URL(url).pathname.split("/").pop() ?? "",
    )
    return leaf || undefined
  } catch {
    return undefined
  }
}

function notionMediaSource(value: unknown): {
  url?: string
  name?: string
  caption: string
} {
  if (!value || typeof value !== "object") return { caption: "" }
  const data = value as Record<string, unknown>
  const name = typeof data.name === "string" ? data.name : undefined
  const caption = "caption" in data ? richTextPlainText(data.caption) : ""
  if (
    data.type === "file" &&
    data.file &&
    typeof data.file === "object" &&
    "url" in data.file
  ) {
    return { url: String(data.file.url), name, caption }
  }
  if (
    data.type === "external" &&
    data.external &&
    typeof data.external === "object" &&
    "url" in data.external
  ) {
    return { url: String(data.external.url), name, caption }
  }
  return { name, caption }
}

function collectBlockMedia(
  blocks: NotionBlock[],
  refs: NotionMediaRef[],
): void {
  for (const block of blocks) {
    if (["image", "file", "video", "pdf", "audio"].includes(block.type)) {
      const source = notionMediaSource(block[block.type])
      refs.push({
        key: block.id,
        pathKey: block.id,
        kind: block.type === "image" ? "image" : "file",
        url: source.url,
        name:
          source.name ?? (source.url ? filenameFromUrl(source.url) : undefined),
        caption: source.caption,
      })
    }
    if (block.children) collectBlockMedia(block.children, refs)
  }
}

function collectPageChrome(page: NotionPage): NotionMediaRef[] {
  const refs: NotionMediaRef[] = []
  for (const [key, label] of [
    ["cover", "Cover"],
    ["icon", "Icon"],
  ] as const) {
    const value = page[key]
    if (!value || typeof value !== "object") continue
    if ("type" in value && value.type === "emoji") continue
    const source = notionMediaSource(value)
    refs.push({
      key,
      pathKey: key,
      kind: "image",
      url: source.url,
      name:
        source.name ?? (source.url ? filenameFromUrl(source.url) : undefined),
      caption: label,
    })
  }
  return refs
}

function filesPropertyContentLeaf(pathKey: string, bytes: Uint8Array): string {
  const separator = pathKey.lastIndexOf("--")
  const stem = separator === -1 ? pathKey : pathKey.slice(0, separator)
  const name = separator === -1 ? "attachment" : pathKey.slice(separator + 2)
  return `${stem}--${gitBlobSha(bytes)}--${name}`
}

function collectFilesProperties(page: NotionPage): NotionMediaRef[] {
  const refs: NotionMediaRef[] = []
  for (const [name, value] of Object.entries(page.properties ?? {})) {
    const keys = notionFilesPropertyAssetKeys(name, value)
    if (keys.length === 0 || !value || typeof value !== "object") continue
    const files = (value as { files?: unknown }).files
    if (!Array.isArray(files)) continue
    files.forEach((item, index) => {
      const source = notionMediaSource(item)
      const key = keys[index]
      if (!key) return
      const itemName =
        item && typeof item === "object" && "name" in item
          ? String(item.name)
          : undefined
      refs.push({
        key: key.mapKey,
        pathKey: key.pathKey,
        assetLeaf: key.contentIdentity ? undefined : key.pathKey,
        contentIdentity: key.contentIdentity,
        kind: "file",
        url: source.url,
        name:
          itemName ||
          source.name ||
          (source.url ? filenameFromUrl(source.url) : undefined),
        caption: itemName ?? "",
      })
    })
  }
  return refs
}

export async function captureNotionEntityAssets(input: {
  markdownPath: string
  page: NotionPage
  blocks: NotionBlock[]
  downloadAsset?: DownloadAsset
}): Promise<{ assetMap: NotionAssetMap; files: CommitFile[] }> {
  const downloadAsset = input.downloadAsset ?? downloadConnectorAsset
  const refs: NotionMediaRef[] = [
    ...collectPageChrome(input.page),
    ...collectFilesProperties(input.page),
  ]
  collectBlockMedia(input.blocks, refs)

  const budget = createConnectorAssetBudget()
  const assetMap = new Map<string, NotionCapturedAsset>()
  const files: CommitFile[] = []
  const entityDir = posix.dirname(input.markdownPath)
  const permalink = input.page.url ?? null

  for (const ref of refs) {
    const alt = ref.caption || ref.name || ref.pathKey
    const stub = (): NotionCapturedAsset => ({
      status: "stub",
      alt,
      permalink,
      kind: ref.kind,
    })
    if (!ref.url) {
      assetMap.set(ref.key, stub())
      continue
    }
    const result = await downloadAsset({
      url: ref.url,
      budget,
      filename: ref.name,
    })
    if (result.status !== "downloaded") {
      log.warn({
        step: "notion.asset.stub",
        message: "Notion media download fell back to a permalink stub",
        reason: result.reason,
        key: ref.key,
        pageId: input.page.id,
      })
      assetMap.set(ref.key, stub())
      continue
    }
    const leaf = ref.contentIdentity
      ? filesPropertyContentLeaf(ref.pathKey, result.bytes)
      : (ref.assetLeaf ?? `${ref.pathKey}--${result.filename}`)
    const path = posix.join(entityDir, "assets", leaf)
    if (!files.some((file) => file.path === path)) {
      files.push(connectorAssetCommitFile(path, result.bytes))
    }
    assetMap.set(ref.key, {
      status: "ok",
      relativePath: `./assets/${leaf}`,
      alt,
      kind: ref.kind,
    })
  }

  return { assetMap, files }
}

export function notionCommitFilesExcludingUnchanged(input: {
  files: CommitFile[]
  existingBlobs: ReadonlyArray<{ path: string; sha: string }>
}): CommitFile[] {
  const shaByPath = new Map(
    input.existingBlobs.map((blob) => [blob.path, blob.sha]),
  )
  return input.files.filter(
    (file) => !connectorCommitFileUnchanged(file, shaByPath),
  )
}

export async function buildNotionPageMirrorFiles(input: {
  resource: { externalId: string; title: string; url?: string | null }
  page: NotionPage
  blocks: NotionBlock[]
  path?: string
  pathByNotionId?: ReadonlyMap<string, string>
  ancestors?: Array<{ id: string; title: string }>
  downloadAsset?: DownloadAsset
}): Promise<CommitFile[]> {
  const markdownPath =
    input.path ??
    getNotionPagePath({ page: input.page, ancestors: input.ancestors })
  const captured = await captureNotionEntityAssets({
    markdownPath,
    page: input.page,
    blocks: input.blocks,
    downloadAsset: input.downloadAsset,
  })
  const markdown = toNotionMarkdownFile({
    resource: input.resource,
    page: input.page,
    blocks: input.blocks,
    path: markdownPath,
    pathByNotionId: input.pathByNotionId,
    assets: captured.assetMap,
  })
  return [markdown, ...captured.files]
}

export async function buildNotionDatabaseMirrorFiles(input: {
  resource: { externalId: string; title: string; url?: string | null }
  rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
  pathByNotionId?: ReadonlyMap<string, string>
  downloadAsset?: DownloadAsset
}): Promise<CommitFile[]> {
  const rowAssets = new Map<string, NotionAssetMap>()
  const assetFiles: CommitFile[] = []
  for (const { page, blocks } of input.rows) {
    const captured = await captureNotionEntityAssets({
      markdownPath: getNotionDatabaseRowPath({
        resource: input.resource,
        page,
      }),
      page,
      blocks,
      downloadAsset: input.downloadAsset,
    })
    rowAssets.set(page.id, captured.assetMap)
    assetFiles.push(...captured.files)
  }
  return [
    ...toNotionDatabaseFiles({
      resource: input.resource,
      rows: input.rows,
      pathByNotionId: input.pathByNotionId,
      rowAssets,
    }),
    ...assetFiles,
  ]
}
