import slugify from "@sindresorhus/slugify"

const MANAGED_ROOT = "confluence"

function htmlToMarkdown(input: string): string {
  const withLineBreaks = input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr)>/gi, "\n")
  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, "")
  const decoded = withoutTags
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"")
  return decoded
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function toConfluenceMarkdownFile(input: {
  spaceKey: string
  pageId: string
  title: string
  bodyStorage: string
}): { path: string; content: string } {
  const pageSlug = slugify(input.title, { lowercase: true })
  const safeSlug = pageSlug.length > 0 ? pageSlug : "untitled"
  const path = `${MANAGED_ROOT}/${input.spaceKey}/${safeSlug}--${input.pageId}.md`
  const content = `# ${input.title}\n\n${htmlToMarkdown(input.bodyStorage)}\n`
  return { path, content }
}

export function getManagedConfluenceRootPath(): string {
  return `${MANAGED_ROOT}/`
}
