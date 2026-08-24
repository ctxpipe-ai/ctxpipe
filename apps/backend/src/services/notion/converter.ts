import { extname, posix } from "node:path"
import slugify from "@sindresorhus/slugify"
import { sanitizeConnectorAssetName } from "../connectors/assets.js"
import type { NotionBlock, NotionPage } from "./client.js"
import { getNotionPageTitle } from "./client.js"

const MANAGED_ROOT = "notion"

function titleSlug(title: string): string {
  const s = slugify(title, { lowercase: true })
  return s.length > 0 ? s : "untitled"
}

export function getNotionPagePath(input: {
  page: NotionPage
  ancestors?: Array<{ id: string; title: string }>
}): string {
  const title = getNotionPageTitle(input.page)
  const segments = [
    ...(input.ancestors ?? []).map(
      (ancestor) => `${titleSlug(ancestor.title)}--${ancestor.id}`,
    ),
    `${titleSlug(title)}--${input.page.id}`,
  ]
  return `${MANAGED_ROOT}/pages/${segments.join("/")}/index.md`
}

export function notionIdKey(id: string): string {
  return id.replaceAll("-", "").toLowerCase()
}

export type NotionFilesPropertyAssetKey = {
  mapKey: string
  pathKey: string
  contentIdentity?: boolean
}

function notionPropertyStableId(
  propertyName: string,
  property: unknown,
): string {
  if (
    property &&
    typeof property === "object" &&
    "id" in property &&
    typeof property.id === "string" &&
    property.id.length > 0
  ) {
    return property.id
  }
  return propertyName
}

function notionFilesItemUploadId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined
  const upload = (item as { file_upload?: unknown }).file_upload
  if (
    upload &&
    typeof upload === "object" &&
    "id" in upload &&
    typeof upload.id === "string" &&
    upload.id.length > 0
  ) {
    return upload.id
  }
  return undefined
}

function notionFilesItemName(item: unknown): string {
  if (
    item &&
    typeof item === "object" &&
    "name" in item &&
    typeof item.name === "string" &&
    item.name.length > 0
  ) {
    return item.name
  }
  return "attachment"
}

function withDuplicateNameSuffix(base: string, occurrence: number): string {
  if (occurrence <= 1) return base
  const extension = extname(base)
  const stem = extension ? base.slice(0, -extension.length) : base
  return `${stem}-${occurrence}${extension}`
}

export function notionFilesPropertyAssetKeys(
  propertyName: string,
  property: unknown,
): NotionFilesPropertyAssetKey[] {
  if (!property || typeof property !== "object" || !("type" in property)) {
    return []
  }
  const files = (property as { type?: unknown; files?: unknown }).files
  if (
    (property as { type?: unknown }).type !== "files" ||
    !Array.isArray(files)
  ) {
    return []
  }
  const propertyId = notionPropertyStableId(propertyName, property)
  const propertyStem = slugify(propertyId, { lowercase: true }) || "files"
  const nameCounts = new Map<string, number>()
  const sanitisedNames = files.map((item) => {
    if (notionFilesItemUploadId(item)) return undefined
    const sanitised = sanitizeConnectorAssetName(notionFilesItemName(item))
    nameCounts.set(sanitised, (nameCounts.get(sanitised) ?? 0) + 1)
    return sanitised
  })
  const nameOccurrences = new Map<string, number>()
  return files.map((item, index) => {
    const uploadId = notionFilesItemUploadId(item)
    if (uploadId) {
      return {
        mapKey: `files:${propertyId}:${uploadId}`,
        pathKey: `${propertyStem}--${uploadId}`,
      }
    }
    const sanitised = sanitisedNames[index] ?? "attachment"
    const next = (nameOccurrences.get(sanitised) ?? 0) + 1
    nameOccurrences.set(sanitised, next)
    return {
      mapKey: `files:${propertyId}:${withDuplicateNameSuffix(sanitised, next)}`,
      pathKey: `${propertyStem}--${sanitised}`,
      contentIdentity: (nameCounts.get(sanitised) ?? 0) > 1,
    }
  })
}

export type NotionCapturedAsset =
  | {
      status: "ok"
      relativePath: string
      alt: string
      kind: "image" | "file"
    }
  | {
      status: "stub"
      alt: string
      permalink: string | null
      kind: "image" | "file"
    }

export type NotionAssetMap = ReadonlyMap<string, NotionCapturedAsset>

type NotionLinkContext = {
  currentPath: string
  pathByNotionId?: ReadonlyMap<string, string>
  assets?: NotionAssetMap
  pageUrl?: string | null
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

function markdownLinkTarget(
  notionId: string | undefined,
  href: string | undefined,
  context: NotionLinkContext,
): string | undefined {
  const idFromHref = href?.match(
    /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})(?=[?#]|$)/i,
  )?.[1]
  const localPath = context.pathByNotionId?.get(
    notionIdKey(notionId ?? idFromHref ?? ""),
  )
  if (!localPath) return href

  const relative = posix.relative(posix.dirname(context.currentPath), localPath)
  return relative.startsWith(".") ? relative : `./${relative}`
}

function richTextMarkdown(value: unknown, context: NotionLinkContext): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const text =
        "plain_text" in part && typeof part.plain_text === "string"
          ? part.plain_text
          : ""
      const href =
        "href" in part && typeof part.href === "string" ? part.href : undefined
      const mention =
        "mention" in part && part.mention && typeof part.mention === "object"
          ? part.mention
          : undefined
      const notionId =
        mention &&
        "type" in mention &&
        mention.type === "page" &&
        "page" in mention &&
        mention.page &&
        typeof mention.page === "object" &&
        "id" in mention.page &&
        typeof mention.page.id === "string"
          ? mention.page.id
          : undefined
      const target = markdownLinkTarget(notionId, href, context)
      return target ? `[${text.replaceAll("]", "\\]")}](${target})` : text
    })
    .join("")
}

function blockText(block: NotionBlock, context: NotionLinkContext): string {
  const data = block[block.type]
  if (!data || typeof data !== "object" || !("rich_text" in data)) return ""
  return richTextMarkdown(data.rich_text, context)
}

function markdownLabel(value: string): string {
  return value.replaceAll("]", "\\]")
}

function renderCapturedMedia(
  blockType: string,
  caption: string,
  captured: NotionCapturedAsset | undefined,
  pageUrl: string | null | undefined,
): string {
  const kind = captured?.kind ?? (blockType === "image" ? "image" : "file")
  const alt = captured?.alt || caption
  if (captured?.status === "ok") {
    const label = markdownLabel(alt || blockType)
    return kind === "image"
      ? `![${label}](${captured.relativePath})`
      : `[${label}](${captured.relativePath})`
  }
  const permalink =
    captured?.status === "stub" ? captured.permalink : (pageUrl ?? null)
  const stubLabel = caption ? `${blockType}: ${caption}` : blockType
  return permalink
    ? `[${markdownLabel(stubLabel)}](${permalink})`
    : `[${stubLabel}]`
}

function mediaBlockText(
  block: NotionBlock,
  context: NotionLinkContext,
): string {
  const data = block[block.type]
  const caption =
    data && typeof data === "object" && "caption" in data
      ? richTextPlainText(data.caption)
      : ""
  return renderCapturedMedia(
    block.type,
    caption,
    context.assets?.get(block.id),
    context.pageUrl,
  )
}

function markdownForBlock(
  block: NotionBlock,
  context: NotionLinkContext,
  indent = "",
): string {
  const text = blockText(block, context)
  let line: string
  switch (block.type) {
    case "paragraph":
      line = text
      break
    case "heading_1":
      line = text ? `# ${text}` : ""
      break
    case "heading_2":
      line = text ? `## ${text}` : ""
      break
    case "heading_3":
      line = text ? `### ${text}` : ""
      break
    case "bulleted_list_item":
      line = text ? `- ${text}` : ""
      break
    case "numbered_list_item":
      line = text ? `1. ${text}` : ""
      break
    case "to_do": {
      const data = block.to_do
      const checked =
        data && typeof data === "object" && "checked" in data
          ? data.checked === true
          : false
      line = text ? `- [${checked ? "x" : " "}] ${text}` : ""
      break
    }
    case "quote":
      line = text ? `> ${text}` : ""
      break
    case "code": {
      const data = block.code
      const language =
        data && typeof data === "object" && "language" in data
          ? String(data.language)
          : ""
      line = `\`\`\`${language}\n${text}\n\`\`\``
      break
    }
    case "divider":
      line = "---"
      break
    case "child_page": {
      const data = block.child_page
      const title =
        data && typeof data === "object" && "title" in data
          ? String(data.title)
          : "Untitled page"
      const target = markdownLinkTarget(block.id, undefined, context)
      line = target ? `[${title}](${target})` : `[Child page: ${title}]`
      break
    }
    case "link_to_page": {
      const data = block.link_to_page
      const notionId =
        data && typeof data === "object"
          ? "page_id" in data && typeof data.page_id === "string"
            ? data.page_id
            : "database_id" in data && typeof data.database_id === "string"
              ? data.database_id
              : undefined
          : undefined
      const target = markdownLinkTarget(notionId, undefined, context)
      line = target ? `[Linked page](${target})` : "[Linked page]"
      break
    }
    case "image":
    case "file":
    case "video":
    case "pdf":
    case "audio": {
      line = mediaBlockText(block, context)
      break
    }
    default:
      line = text || `[${block.type}]`
  }
  const children = (block.children ?? [])
    .map((child) => markdownForBlock(child, context, `${indent}  `))
    .filter(Boolean)
  return [`${indent}${line}`, ...children].filter(Boolean).join("\n")
}

function richTextValue(value: unknown): string {
  return richTextPlainText(value)
}

export function notionPropertyPlainText(value: unknown): string {
  if (!value || typeof value !== "object" || !("type" in value)) return ""
  const property = value as Record<string, unknown>
  const typedValue = property[property.type as string]
  if (property.type === "title" || property.type === "rich_text") {
    return richTextValue(typedValue)
  }
  if (property.type === "number") {
    return typedValue == null ? "" : String(typedValue)
  }
  if (property.type === "checkbox") return typedValue === true ? "Yes" : "No"
  if (property.type === "select" || property.type === "status") {
    if (!typedValue || typeof typedValue !== "object") return ""
    return "name" in typedValue ? String(typedValue.name) : ""
  }
  if (property.type === "multi_select") {
    if (!Array.isArray(typedValue)) return ""
    return typedValue
      .map((item) =>
        item && typeof item === "object" && "name" in item
          ? String(item.name)
          : "",
      )
      .filter(Boolean)
      .join(", ")
  }
  if (property.type === "date") {
    if (!typedValue || typeof typedValue !== "object") return ""
    return "start" in typedValue ? String(typedValue.start) : ""
  }
  if (
    property.type === "url" ||
    property.type === "email" ||
    property.type === "phone_number"
  ) {
    return typedValue == null ? "" : String(typedValue)
  }
  if (property.type === "relation") {
    if (!Array.isArray(typedValue)) return ""
    return typedValue
      .map((item) =>
        item && typeof item === "object" && "id" in item ? String(item.id) : "",
      )
      .filter(Boolean)
      .join(", ")
  }
  if (property.type === "files") {
    if (!Array.isArray(typedValue)) return ""
    return typedValue
      .map((item) =>
        item && typeof item === "object" && "name" in item
          ? String(item.name)
          : "",
      )
      .filter(Boolean)
      .join(", ")
  }
  if (property.type === "formula") return notionPropertyPlainText(typedValue)
  if (property.type === "rollup") {
    if (!typedValue || typeof typedValue !== "object") return ""
    if ("array" in typedValue && Array.isArray(typedValue.array)) {
      return typedValue.array
        .map(notionPropertyPlainText)
        .filter(Boolean)
        .join(", ")
    }
    if ("number" in typedValue)
      return typedValue.number == null ? "" : String(typedValue.number)
  }
  return ""
}

export function toNotionMarkdownFile(input: {
  resource: { externalId: string; title: string; url?: string | null }
  page: NotionPage
  blocks: NotionBlock[]
  path?: string
  pathByNotionId?: ReadonlyMap<string, string>
  assets?: NotionAssetMap
}): { path: string; content: string } {
  const title = getNotionPageTitle(input.page) || input.resource.title
  const path =
    input.path ??
    `${MANAGED_ROOT}/pages/${titleSlug(title)}--${input.resource.externalId}/index.md`
  const context: NotionLinkContext = {
    currentPath: path,
    pathByNotionId: input.pathByNotionId,
    assets: input.assets,
    pageUrl: input.page.url ?? input.resource.url,
  }
  const frontmatter = [
    "---",
    `source: notion`,
    `notion_id: ${JSON.stringify(input.page.id)}`,
    `title: ${JSON.stringify(title)}`,
    input.page.url ? `url: ${JSON.stringify(input.page.url)}` : null,
    input.page.last_edited_time
      ? `last_edited_time: ${JSON.stringify(input.page.last_edited_time)}`
      : null,
    "---",
  ]
    .filter((line): line is string => line != null)
    .join("\n")

  const chrome = ["cover", "icon"]
    .map((key) => {
      const captured = input.assets?.get(key)
      if (!captured) return ""
      return renderCapturedMedia(
        captured.kind === "image" ? "image" : "file",
        captured.alt,
        captured,
        context.pageUrl,
      )
    })
    .filter(Boolean)
  const body = input.blocks
    .map((block) => markdownForBlock(block, context))
    .map((text) => text.trimEnd())
    .filter(Boolean)
    .join("\n\n")
  const bodyParts = [...chrome, body].filter(Boolean).join("\n\n")

  return {
    path,
    content: `${frontmatter}\n\n# ${title}\n\n${bodyParts}\n`,
  }
}

function databaseSegment(resource: { externalId: string; title: string }) {
  return `${titleSlug(resource.title)}--${resource.externalId}`
}

function rowSegment(page: NotionPage) {
  return `${titleSlug(getNotionPageTitle(page))}--${page.id}`
}

export function getNotionDatabaseIndexPath(resource: {
  externalId: string
  title: string
}): string {
  return `${MANAGED_ROOT}/databases/${databaseSegment(resource)}/index.md`
}

export function getNotionDatabaseCsvPath(resource: {
  externalId: string
  title: string
}): string {
  return `${MANAGED_ROOT}/databases/${databaseSegment(resource)}/table.csv`
}

export function getNotionDatabaseRowPath(input: {
  resource: { externalId: string; title: string }
  page: NotionPage
}): string {
  return `${MANAGED_ROOT}/databases/${databaseSegment(input.resource)}/rows/${rowSegment(input.page)}/index.md`
}

function filesPropertyItems(value: unknown): Array<{ name: string }> {
  if (!value || typeof value !== "object" || !("type" in value)) return []
  const property = value as { type?: unknown; files?: unknown }
  if (property.type !== "files" || !Array.isArray(property.files)) return []
  return property.files.map((item) => ({
    name: notionFilesItemName(item),
  }))
}

function propertyMarkdownLine(
  name: string,
  value: unknown,
  assets: NotionAssetMap | undefined,
  pageUrl: string | null | undefined,
): string {
  const keys = notionFilesPropertyAssetKeys(name, value)
  if (keys.length > 0) {
    const files = filesPropertyItems(value)
    const links = keys.map((key, index) => {
      const captured = assets?.get(key.mapKey)
      const label = markdownLabel(captured?.alt || files[index]?.name || "file")
      if (captured?.status === "ok")
        return `[${label}](${captured.relativePath})`
      const permalink =
        captured?.status === "stub" ? captured.permalink : (pageUrl ?? null)
      return permalink ? `[${label}](${permalink})` : label
    })
    return `- **${name}:** ${links.join(", ")}`
  }
  const text = notionPropertyPlainText(value)
  return text ? `- **${name}:** ${text}` : ""
}

export function toNotionDatabaseRowMarkdownFile(input: {
  resource: { externalId: string; title: string; url?: string | null }
  page: NotionPage
  blocks: NotionBlock[]
  pathByNotionId?: ReadonlyMap<string, string>
  assets?: NotionAssetMap
}): { path: string; content: string } {
  const title = getNotionPageTitle(input.page)
  const path = getNotionDatabaseRowPath(input)
  const context: NotionLinkContext = {
    currentPath: path,
    pathByNotionId: input.pathByNotionId,
    assets: input.assets,
    pageUrl: input.page.url ?? input.resource.url,
  }
  const propertyEntries = Object.entries(input.page.properties ?? {})
  const properties = propertyEntries
    .map(([name, value]) =>
      propertyMarkdownLine(name, value, input.assets, context.pageUrl),
    )
    .filter(Boolean)
  const frontmatterProperties = Object.fromEntries(
    propertyEntries
      .map(([name, value]) => [name, notionPropertyPlainText(value)] as const)
      .filter(([, value]) => value),
  )
  const chrome = ["cover", "icon"]
    .map((key) => {
      const captured = input.assets?.get(key)
      if (!captured) return ""
      return renderCapturedMedia(
        captured.kind === "image" ? "image" : "file",
        captured.alt,
        captured,
        context.pageUrl,
      )
    })
    .filter(Boolean)
  const body = input.blocks
    .map((block) => markdownForBlock(block, context))
    .map((text) => text.trimEnd())
    .filter(Boolean)
    .join("\n\n")
  const bodyParts = [...chrome, properties.join("\n"), body]
    .filter(Boolean)
    .join("\n\n")
  const frontmatter = [
    "---",
    "source: notion",
    `notion_id: ${JSON.stringify(input.page.id)}`,
    `database_id: ${JSON.stringify(input.resource.externalId)}`,
    `title: ${JSON.stringify(title)}`,
    `properties: ${JSON.stringify(frontmatterProperties)}`,
    input.page.url ? `url: ${JSON.stringify(input.page.url)}` : null,
    input.page.last_edited_time
      ? `last_edited_time: ${JSON.stringify(input.page.last_edited_time)}`
      : null,
    "---",
  ]
    .filter((line): line is string => line != null)
    .join("\n")
  return {
    path,
    content: `${frontmatter}\n\n# ${title}\n\n${bodyParts}\n`,
  }
}

export function toNotionDatabaseIndexMarkdownFile(input: {
  resource: { externalId: string; title: string; url?: string | null }
  rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
}): { path: string; content: string } {
  const path = getNotionDatabaseIndexPath(input.resource)
  const links = input.rows.map(({ page }) => {
    const title = getNotionPageTitle(page)
    const rowPath = getNotionDatabaseRowPath({ resource: input.resource, page })
    const relative = posix.relative(posix.dirname(path), rowPath)
    return `- [${title}](./${relative})`
  })
  const frontmatter = [
    "---",
    "source: notion",
    `notion_id: ${JSON.stringify(input.resource.externalId)}`,
    `title: ${JSON.stringify(input.resource.title)}`,
    "type: database",
    `row_count: ${input.rows.length}`,
    input.resource.url ? `url: ${JSON.stringify(input.resource.url)}` : null,
    "---",
  ]
    .filter((line): line is string => line != null)
    .join("\n")
  return {
    path,
    content: `${frontmatter}\n\n# ${input.resource.title}\n\n[View table as CSV](./table.csv)\n\n${links.join("\n")}\n`,
  }
}

function csvCell(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  return /[",\n]/.test(normalized)
    ? `"${normalized.replaceAll('"', '""')}"`
    : normalized
}

export function toNotionDatabaseCsvFile(input: {
  resource: { externalId: string; title: string }
  rows: Array<{ page: NotionPage }>
}): { path: string; content: string } {
  const propertyNames = [
    ...new Set(
      input.rows.flatMap(({ page }) => Object.keys(page.properties ?? {})),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const headers = [
    ...propertyNames,
    "_ctxpipe_notion_id",
    "_ctxpipe_title",
    "_ctxpipe_notion_url",
    "_ctxpipe_last_edited_time",
    "_ctxpipe_row_path",
  ]
  const lines = [
    headers.map(csvCell).join(","),
    ...input.rows.map(({ page }) => {
      const rowPath = getNotionDatabaseRowPath({
        resource: input.resource,
        page,
      })
      const values = [
        ...propertyNames.map((name) =>
          notionPropertyPlainText(page.properties?.[name]),
        ),
        page.id,
        getNotionPageTitle(page),
        page.url ?? "",
        page.last_edited_time ?? "",
        `./${posix.relative(posix.dirname(getNotionDatabaseCsvPath(input.resource)), rowPath)}`,
      ]
      return values.map(csvCell).join(",")
    }),
  ]
  return {
    path: getNotionDatabaseCsvPath(input.resource),
    content: `${lines.join("\n")}\n`,
  }
}

export function toNotionDatabaseFiles(input: {
  resource: { externalId: string; title: string; url?: string | null }
  rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
  pathByNotionId?: ReadonlyMap<string, string>
  rowAssets?: ReadonlyMap<string, NotionAssetMap>
}): Array<{ path: string; content: string }> {
  return [
    toNotionDatabaseIndexMarkdownFile(input),
    toNotionDatabaseCsvFile(input),
    ...input.rows.map(({ page, blocks }) =>
      toNotionDatabaseRowMarkdownFile({
        resource: input.resource,
        page,
        blocks,
        pathByNotionId: input.pathByNotionId,
        assets: input.rowAssets?.get(page.id),
      }),
    ),
  ]
}

export function getManagedNotionRootPath(): string {
  return `${MANAGED_ROOT}/`
}
