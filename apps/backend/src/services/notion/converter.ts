import slugify from "@sindresorhus/slugify"
import type { NotionBlock, NotionPage } from "./client.js"
import { getNotionPageTitle } from "./client.js"

const MANAGED_ROOT = "notion"

function titleSlug(title: string): string {
  const s = slugify(title, { lowercase: true })
  return s.length > 0 ? s : "untitled"
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

function markdownForBlock(block: NotionBlock): string {
  const text = blockText(block)
  switch (block.type) {
    case "paragraph":
      return text
    case "heading_1":
      return text ? `# ${text}` : ""
    case "heading_2":
      return text ? `## ${text}` : ""
    case "heading_3":
      return text ? `### ${text}` : ""
    case "bulleted_list_item":
      return text ? `- ${text}` : ""
    case "numbered_list_item":
      return text ? `1. ${text}` : ""
    case "to_do":
      return text ? `- [ ] ${text}` : ""
    case "quote":
      return text ? `> ${text}` : ""
    case "code": {
      const data = block.code
      const language =
        data && typeof data === "object" && "language" in data
          ? String(data.language)
          : ""
      return `\`\`\`${language}\n${text}\n\`\`\``
    }
    case "divider":
      return "---"
    default:
      return text
  }
}

export function toNotionMarkdownFile(input: {
  resource: { externalId: string; title: string; url?: string | null }
  page: NotionPage
  blocks: NotionBlock[]
}): { path: string; content: string } {
  const title = getNotionPageTitle(input.page) || input.resource.title
  const path = `${MANAGED_ROOT}/pages/${titleSlug(title)}--${input.resource.externalId}.md`
  const frontmatter = [
    "---",
    `source: notion`,
    `notion_id: ${JSON.stringify(input.resource.externalId)}`,
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
    .map(markdownForBlock)
    .map((text) => text.trimEnd())
    .filter(Boolean)
    .join("\n\n")

  return {
    path,
    content: `${frontmatter}\n\n# ${title}\n\n${body}\n`,
  }
}

export function getManagedNotionRootPath(): string {
  return `${MANAGED_ROOT}/`
}
