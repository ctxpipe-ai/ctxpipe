import { posix } from "node:path"
import { log } from "../../observability/logger.js"
import {
  CONNECTOR_ENTITY_MAX_ASSETS,
  type ConnectorAssetBytePool,
  type ConnectorAssetDownloadResult,
  connectorAssetCommitFile,
  connectorBlobUnchanged,
  connectorCommitFileUnchanged,
  connectorPathMatchesPreservation,
  consumeConnectorAssetBytePool,
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
  propertyIdentity?: string
  propertyStem?: string
  assetLeaf?: string
  contentIdentity?: boolean
  kind: "image" | "file"
  url?: string
  name?: string
  caption: string
  expiryTime?: string
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

export function notionMatchingExistingAssetPaths(
  paths: Iterable<string>,
  preservation: string,
): string[] {
  const marker = "/assets/"
  const markerIndex = preservation.indexOf(marker)
  if (markerIndex < 0) return []
  const ownerSegment = preservation.slice(0, markerIndex).split("/").at(-1)
  const ownerSeparator = ownerSegment?.lastIndexOf("--") ?? -1
  if (!ownerSegment || ownerSeparator < 0) return []
  const ownerId = ownerSegment.slice(ownerSeparator + 2).replaceAll("-", "")
  const propertyCollisionSuffix = (suffix: string) =>
    suffix.match(/^properties\/.+?--p([0-9a-f]{8})(?=--)/)?.[1]
  const normalisePropertyCollisionSuffix = (suffix: string) =>
    suffix.replace(/^(properties\/.+?)--p[0-9a-f]{8}(?=--)/, "$1")
  const contentIdentity = (suffix: string) =>
    suffix.match(/^properties\/.+?--([0-9a-f]{40})(?=--)/)?.[1]
  const normaliseContentIdentity = (suffix: string) =>
    suffix.replace(/^(properties\/.+?)--[0-9a-f]{40}(?=--)/, "$1")
  const preservationSuffix = preservation.slice(markerIndex + marker.length)
  const preservationCollision = propertyCollisionSuffix(preservationSuffix)
  const preservationContent = contentIdentity(preservationSuffix)
  const assetPreservation = normaliseContentIdentity(
    normalisePropertyCollisionSuffix(preservationSuffix),
  )

  return [...paths].filter((path) => {
    const existingMarkerIndex = path.indexOf(marker)
    if (!path.startsWith("notion/") || existingMarkerIndex < 0) return false
    const existingOwner = path.slice(0, existingMarkerIndex).split("/").at(-1)
    const existingSeparator = existingOwner?.lastIndexOf("--") ?? -1
    if (!existingOwner || existingSeparator < 0) return false
    const existingOwnerId = existingOwner
      .slice(existingSeparator + 2)
      .replaceAll("-", "")
    const existingSuffix = path.slice(existingMarkerIndex + marker.length)
    const existingCollision = propertyCollisionSuffix(existingSuffix)
    const existingContent = contentIdentity(existingSuffix)
    if (
      preservationCollision &&
      existingCollision &&
      preservationCollision !== existingCollision
    ) {
      return false
    }
    if (
      preservationContent &&
      existingContent &&
      preservationContent !== existingContent
    ) {
      return false
    }
    return (
      existingOwnerId.toLowerCase() === ownerId.toLowerCase() &&
      connectorPathMatchesPreservation(
        normaliseContentIdentity(
          normalisePropertyCollisionSuffix(existingSuffix),
        ),
        assetPreservation,
      )
    )
  })
}

function notionMediaSource(value: unknown): {
  url?: string
  name?: string
  caption: string
  expiryTime?: string
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
    const expiryTime =
      "expiry_time" in data.file && typeof data.file.expiry_time === "string"
        ? data.file.expiry_time
        : undefined
    return { url: String(data.file.url), name, caption, expiryTime }
  }
  if (
    data.type === "external" &&
    data.external &&
    typeof data.external === "object" &&
    "url" in data.external
  ) {
    return { url: String(data.external.url), name, caption }
  }
  if (
    data.type === "custom_emoji" &&
    data.custom_emoji &&
    typeof data.custom_emoji === "object" &&
    "url" in data.custom_emoji
  ) {
    return { url: String(data.custom_emoji.url), name, caption }
  }
  if (typeof data.url === "string") {
    return { url: data.url, name, caption }
  }
  return { name, caption }
}

function collectBlockMedia(
  blocks: NotionBlock[],
  refs: NotionMediaRef[],
): void {
  for (const block of blocks) {
    if (
      ["image", "file", "video", "pdf", "audio", "embed"].includes(block.type)
    ) {
      const source = notionMediaSource(block[block.type])
      refs.push({
        key: block.id,
        pathKey: block.id,
        kind: block.type === "image" ? "image" : "file",
        url: source.url,
        name:
          source.name ?? (source.url ? filenameFromUrl(source.url) : undefined),
        caption: source.caption,
        expiryTime: source.expiryTime,
      })
    }
    if (block.type === "callout") {
      const data = block.callout
      const icon =
        data && typeof data === "object" && "icon" in data
          ? data.icon
          : undefined
      const source = notionMediaSource(icon)
      if (source.url) {
        refs.push({
          key: `${block.id}:icon`,
          pathKey: `${block.id}-icon`,
          kind: "image",
          url: source.url,
          name:
            source.name ??
            (source.url ? filenameFromUrl(source.url) : undefined),
          caption: "Callout icon",
          expiryTime: source.expiryTime,
        })
      }
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
      expiryTime: source.expiryTime,
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
        propertyIdentity: key.propertyIdentity,
        propertyStem: key.propertyStem,
        assetLeaf: key.contentIdentity ? undefined : key.pathKey,
        contentIdentity: key.contentIdentity,
        kind: "file",
        url: source.url,
        name:
          itemName ||
          source.name ||
          (source.url ? filenameFromUrl(source.url) : undefined),
        caption: itemName ?? "",
        expiryTime: source.expiryTime,
      })
    })
  }
  const identitiesByStem = new Map<string, Set<string>>()
  for (const ref of refs) {
    if (!ref.propertyIdentity || !ref.propertyStem) continue
    const identities =
      identitiesByStem.get(ref.propertyStem) ?? new Set<string>()
    identities.add(ref.propertyIdentity)
    identitiesByStem.set(ref.propertyStem, identities)
  }
  for (const ref of refs) {
    if (
      !ref.propertyIdentity ||
      !ref.propertyStem ||
      (identitiesByStem.get(ref.propertyStem)?.size ?? 0) < 2
    ) {
      continue
    }
    const suffix = gitBlobSha(Buffer.from(ref.propertyIdentity)).slice(0, 8)
    const disambiguatedStem = `${ref.propertyStem}--p${suffix}`
    ref.pathKey = `${disambiguatedStem}${ref.pathKey.slice(ref.propertyStem.length)}`
    if (ref.assetLeaf !== undefined) ref.assetLeaf = ref.pathKey
  }
  return refs
}

export type NotionEntityAssetCapture = {
  assetMap: NotionAssetMap
  files: CommitFile[]
  preservePathPrefixes: string[]
}

export async function captureNotionEntityAssets(input: {
  markdownPath: string
  page: NotionPage
  blocks: NotionBlock[]
  downloadAsset?: DownloadAsset
  bytePool?: ConnectorAssetBytePool
  existingShaByPath?: ReadonlyMap<string, string>
}): Promise<NotionEntityAssetCapture> {
  const downloadAsset = input.downloadAsset ?? downloadConnectorAsset
  const refs: NotionMediaRef[] = [
    ...collectPageChrome(input.page),
    ...collectFilesProperties(input.page),
  ]
  collectBlockMedia(input.blocks, refs)
  refs.sort((left, right) => {
    const leftExpiry = left.expiryTime
      ? Date.parse(left.expiryTime)
      : Number.POSITIVE_INFINITY
    const rightExpiry = right.expiryTime
      ? Date.parse(right.expiryTime)
      : Number.POSITIVE_INFINITY
    return leftExpiry - rightExpiry
  })

  const budget = createConnectorAssetBudget()
  const assetMap = new Map<string, NotionCapturedAsset>()
  const files: CommitFile[] = []
  const preservePathPrefixes: string[] = []
  let remainingDeclaredAssets = CONNECTOR_ENTITY_MAX_ASSETS
  const entityDir = posix.dirname(input.markdownPath)
  const permalink = input.page.url ?? null
  const preservePrefixFor = (ref: NotionMediaRef) => {
    if (ref.propertyIdentity && ref.propertyStem) {
      const identitySuffix = gitBlobSha(
        Buffer.from(ref.propertyIdentity),
      ).slice(0, 8)
      const identityStem = `${ref.propertyStem}--p${identitySuffix}`
      const identityPathKey = ref.pathKey.startsWith(`${ref.propertyStem}--p`)
        ? ref.pathKey
        : `${identityStem}${ref.pathKey.slice(ref.propertyStem.length)}`
      const separator = identityPathKey.lastIndexOf("--")
      const stem =
        separator === -1 ? identityPathKey : identityPathKey.slice(0, separator)
      return posix.join(entityDir, "assets", `${stem}--`)
    }
    return posix.join(entityDir, "assets", ref.assetLeaf ?? `${ref.pathKey}--`)
  }

  for (const ref of refs) {
    const alt = ref.caption || ref.name || ref.pathKey
    const stub = (): NotionCapturedAsset => ({
      status: "stub",
      alt,
      permalink,
      kind: ref.kind,
    })
    if (remainingDeclaredAssets <= 0) {
      preservePathPrefixes.push(preservePrefixFor(ref))
      assetMap.set(ref.key, stub())
      continue
    }
    remainingDeclaredAssets -= 1
    if (!ref.url) {
      preservePathPrefixes.push(preservePrefixFor(ref))
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
      if (
        result.reason === "download_failed" ||
        result.reason === "entity_limit"
      ) {
        preservePathPrefixes.push(preservePrefixFor(ref))
      }
      assetMap.set(ref.key, stub())
      continue
    }
    const leaf = ref.contentIdentity
      ? filesPropertyContentLeaf(ref.pathKey, result.bytes)
      : (ref.assetLeaf ?? `${ref.pathKey}--${result.filename}`)
    const path = posix.join(entityDir, "assets", leaf)
    const alreadyCaptured = files.some((file) => file.path === path)
    const unchangedExisting =
      !alreadyCaptured &&
      input.existingShaByPath &&
      connectorBlobUnchanged(path, result.bytes, input.existingShaByPath)
    if (unchangedExisting) {
      preservePathPrefixes.push(path)
    }
    if (
      !alreadyCaptured &&
      !unchangedExisting &&
      input.bytePool &&
      !consumeConnectorAssetBytePool(input.bytePool, result.bytes.byteLength)
    ) {
      preservePathPrefixes.push(preservePrefixFor(ref))
      assetMap.set(ref.key, stub())
      continue
    }
    if (!alreadyCaptured && !unchangedExisting) {
      files.push(connectorAssetCommitFile(path, result.bytes))
    }
    assetMap.set(ref.key, {
      status: "ok",
      relativePath: `./assets/${leaf}`,
      alt,
      kind: ref.kind,
    })
  }

  return { assetMap, files, preservePathPrefixes }
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
  onPreservePathPrefix?: (prefix: string) => void
  bytePool?: ConnectorAssetBytePool
  existingShaByPath?: ReadonlyMap<string, string>
  capturedAssets?: NotionEntityAssetCapture
}): Promise<CommitFile[]> {
  const markdownPath =
    input.path ??
    getNotionPagePath({ page: input.page, ancestors: input.ancestors })
  const captured =
    input.capturedAssets ??
    (await captureNotionEntityAssets({
      markdownPath,
      page: input.page,
      blocks: input.blocks,
      downloadAsset: input.downloadAsset,
      bytePool: input.bytePool,
      existingShaByPath: input.existingShaByPath,
    }))
  for (const prefix of captured.preservePathPrefixes) {
    input.onPreservePathPrefix?.(prefix)
  }
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
  onPreservePathPrefix?: (prefix: string) => void
  bytePool?: ConnectorAssetBytePool
  existingShaByPath?: ReadonlyMap<string, string>
  capturedAssetsByPageId?: ReadonlyMap<string, NotionEntityAssetCapture>
}): Promise<CommitFile[]> {
  const rowAssets = new Map<string, NotionAssetMap>()
  const assetFiles: CommitFile[] = []
  for (const { page, blocks } of input.rows) {
    const captured =
      input.capturedAssetsByPageId?.get(page.id) ??
      (await captureNotionEntityAssets({
        markdownPath: getNotionDatabaseRowPath({
          resource: input.resource,
          page,
        }),
        page,
        blocks,
        downloadAsset: input.downloadAsset,
        bytePool: input.bytePool,
        existingShaByPath: input.existingShaByPath,
      }))
    for (const prefix of captured.preservePathPrefixes) {
      input.onPreservePathPrefix?.(prefix)
    }
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
