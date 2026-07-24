import slugify from "@sindresorhus/slugify"
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
    `${titleSlug(title)}--${input.page.id}.md`,
  ]
  return `${MANAGED_ROOT}/pages/${segments.join("/")}`
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

function blockText(block: NotionBlock): string {
  const data = block[block.type]
  if (!data || typeof data !== "object" || !("rich_text" in data)) return ""
  return richTextPlainText(data.rich_text)
}

function mediaBlockText(block: NotionBlock): string {
  const data = block[block.type]
  if (!data || typeof data !== "object") return `[${block.type}]`
  const caption = "caption" in data ? richTextPlainText(data.caption) : ""
  if (
    "type" in data &&
    data.type === "external" &&
    "external" in data &&
    data.external &&
    typeof data.external === "object" &&
    "url" in data.external
  ) {
    const url = String(data.external.url)
    return caption
      ? `[${block.type}: ${caption}](${url})`
      : `[${block.type}](${url})`
  }
  return caption ? `[${block.type}: ${caption}]` : `[${block.type}]`
}

function markdownForBlock(block: NotionBlock, indent = ""): string {
  const text = blockText(block)
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
      line = `[Child page: ${title}]`
      break
    }
    case "image":
    case "file":
    case "video": {
      line = mediaBlockText(block)
      break
    }
    default:
      line = text || `[${block.type}]`
  }
  const children = (block.children ?? [])
    .map((child) => markdownForBlock(child, `${indent}  `))
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
}): { path: string; content: string } {
  const title = getNotionPageTitle(input.page) || input.resource.title
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

  const body = input.blocks
    .map((block) => markdownForBlock(block))
    .map((text) => text.trimEnd())
    .filter(Boolean)
    .join("\n\n")

  return {
    path:
      input.path ??
      `${MANAGED_ROOT}/pages/${titleSlug(title)}--${input.resource.externalId}.md`,
    content: `${frontmatter}\n\n# ${title}\n\n${body}\n`,
  }
}

function databaseSegment(resource: { externalId: string; title: string }) {
  return `${titleSlug(resource.title)}--${resource.externalId}`
}

function rowSegment(page: NotionPage) {
  return `${titleSlug(getNotionPageTitle(page))}--${page.id}`
}

export function toNotionDatabaseRowMarkdownFile(input: {
  resource: { externalId: string; title: string; url?: string | null }
  page: NotionPage
  blocks: NotionBlock[]
}): { path: string; content: string } {
  const title = getNotionPageTitle(input.page)
  const properties = Object.entries(input.page.properties ?? {})
    .map(([name, value]) => {
      const text = notionPropertyPlainText(value)
      return text ? `- **${name}:** ${text}` : ""
    })
    .filter(Boolean)
  const body = input.blocks
    .map((block) => markdownForBlock(block))
    .map((text) => text.trimEnd())
    .filter(Boolean)
    .join("\n\n")
  const frontmatter = [
    "---",
    "source: notion",
    `notion_id: ${JSON.stringify(input.page.id)}`,
    `database_id: ${JSON.stringify(input.resource.externalId)}`,
    `title: ${JSON.stringify(title)}`,
    input.page.url ? `url: ${JSON.stringify(input.page.url)}` : null,
    input.page.last_edited_time
      ? `last_edited_time: ${JSON.stringify(input.page.last_edited_time)}`
      : null,
    "---",
  ]
    .filter((line): line is string => line != null)
    .join("\n")
  return {
    path: `${MANAGED_ROOT}/databases/${databaseSegment(input.resource)}/${rowSegment(input.page)}.md`,
    content: `${frontmatter}\n\n# ${title}\n\n${properties.join("\n")}\n\n${body}\n`,
  }
}

export function toNotionDatabaseIndexMarkdownFile(input: {
  resource: { externalId: string; title: string; url?: string | null }
  rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
}): { path: string; content: string } {
  const segment = databaseSegment(input.resource)
  const links = input.rows.map(({ page }) => {
    const title = getNotionPageTitle(page)
    return `- [${title}](./${segment}/${rowSegment(page)}.md)`
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
    path: `${MANAGED_ROOT}/databases/${segment}.md`,
    content: `${frontmatter}\n\n# ${input.resource.title}\n\n${links.join("\n")}\n`,
  }
}

export function toNotionDatabaseMarkdownFiles(input: {
  resource: { externalId: string; title: string; url?: string | null }
  rows: Array<{ page: NotionPage; blocks: NotionBlock[] }>
}): Array<{ path: string; content: string }> {
  return [
    toNotionDatabaseIndexMarkdownFile(input),
    ...input.rows.map(({ page, blocks }) =>
      toNotionDatabaseRowMarkdownFile({
        resource: input.resource,
        page,
        blocks,
      }),
    ),
  ]
}

export function getManagedNotionRootPath(): string {
  return `${MANAGED_ROOT}/`
}
