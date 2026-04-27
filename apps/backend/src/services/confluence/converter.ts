import slugify from "@sindresorhus/slugify"

const MANAGED_ROOT = "confluence"

export type ConfluencePageTreeNode = {
  id: string
  title: string
  parentId: string | null
}

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

function titleSlug(title: string): string {
  const s = slugify(title, { lowercase: true })
  return s.length > 0 ? s : "untitled"
}

function buildChildrenByParent(
  pages: ConfluencePageTreeNode[],
): Map<string | null, string[]> {
  const m = new Map<string | null, string[]>()
  for (const p of pages) {
    const key = p.parentId
    const arr = m.get(key) ?? []
    arr.push(p.id)
    m.set(key, arr)
  }
  return m
}

function buildSegmentByPageId(pages: ConfluencePageTreeNode[]): Map<string, string> {
  const byParent = new Map<string | null, ConfluencePageTreeNode[]>()
  for (const p of pages) {
    const key = p.parentId
    const list = byParent.get(key) ?? []
    list.push(p)
    byParent.set(key, list)
  }
  const segmentByPageId = new Map<string, string>()
  for (const siblings of byParent.values()) {
    const slugCounts = new Map<string, number>()
    for (const s of siblings) {
      const sl = titleSlug(s.title)
      slugCounts.set(sl, (slugCounts.get(sl) ?? 0) + 1)
    }
    for (const s of siblings) {
      const base = titleSlug(s.title)
      const seg = (slugCounts.get(base) ?? 0) > 1 ? `${base}--${s.id}` : base
      segmentByPageId.set(s.id, seg)
    }
  }
  return segmentByPageId
}

function ancestorPageIds(
  pageId: string,
  pagesById: Map<string, ConfluencePageTreeNode>,
  /** Confluence often parents “space root” pages under the space homepage; omit that id so paths start under `confluence/<spaceKey>/`. */
  pathRootSkipPageIds: Set<string>,
): string[] {
  const rev: string[] = []
  let cur = pagesById.get(pageId)
  while (cur?.parentId) {
    const parentId = cur.parentId
    if (!pagesById.has(parentId)) break
    if (pathRootSkipPageIds.has(parentId)) break
    rev.push(parentId)
    cur = pagesById.get(parentId)
  }
  rev.reverse()
  return rev
}

function pageHasSelectedDescendant(
  pageId: string,
  selectedIds: Set<string>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  const stack = [...(childrenByParent.get(pageId) ?? [])]
  while (stack.length) {
    const id = stack.pop()
    if (id === undefined) continue
    if (selectedIds.has(id)) return true
    stack.push(...(childrenByParent.get(id) ?? []))
  }
  return false
}

/** Relative repo path under `confluence/<spaceKey>/` for a synced page. */
export function buildConfluenceMarkdownRelPath(input: {
  spaceKey: string
  pageId: string
  pages: ConfluencePageTreeNode[]
  selectedIds: Set<string>
  /** Usually the space’s `homepageId` so top-level pages are not nested under a duplicate of the space name. */
  pathRootSkipPageIds?: Set<string>
}): string {
  const pathRootSkipPageIds = input.pathRootSkipPageIds ?? new Set()
  const pagesById = new Map(input.pages.map((p) => [p.id, p]))
  const segmentByPageId = buildSegmentByPageId(input.pages)
  const childrenByParent = buildChildrenByParent(input.pages)
  const anc = ancestorPageIds(input.pageId, pagesById, pathRootSkipPageIds)
  const prefixSegs: string[] = []
  for (const id of anc) {
    const seg = segmentByPageId.get(id)
    if (!seg) {
      throw new Error(`Confluence sync: missing path segment for ancestor page ${id}`)
    }
    prefixSegs.push(seg)
  }
  const selfSeg = segmentByPageId.get(input.pageId)
  if (!selfSeg) {
    throw new Error(`Confluence sync: missing path segment for page ${input.pageId}`)
  }
  const prefix =
    `${MANAGED_ROOT}/${input.spaceKey}/` +
    (prefixSegs.length > 0 ? `${prefixSegs.join("/")}/` : "")

  const isBranch = pageHasSelectedDescendant(
    input.pageId,
    input.selectedIds,
    childrenByParent,
  )
  if (isBranch) {
    return `${prefix}${selfSeg}/index.md`
  }
  return `${prefix}${selfSeg}--${input.pageId}.md`
}

export function toConfluenceMarkdownFile(input: {
  spaceKey: string
  pageId: string
  title: string
  bodyStorage: string
  pages: ConfluencePageTreeNode[]
  selectedIds: Set<string>
  pathRootSkipPageIds?: Set<string>
}): { path: string; content: string } {
  const path = buildConfluenceMarkdownRelPath({
    spaceKey: input.spaceKey,
    pageId: input.pageId,
    pages: input.pages,
    selectedIds: input.selectedIds,
    pathRootSkipPageIds: input.pathRootSkipPageIds,
  })
  const content = `# ${input.title}\n\n${htmlToMarkdown(input.bodyStorage)}\n`
  return { path, content }
}

export function getManagedConfluenceRootPath(): string {
  return `${MANAGED_ROOT}/`
}
