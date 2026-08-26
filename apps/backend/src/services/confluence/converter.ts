import { createHash } from "node:crypto"
import { posix as pathPosix } from "node:path"
import slugify from "@sindresorhus/slugify"
import {
  canonicalConnectorAssetUrl,
  sanitizeConnectorAssetName,
} from "../connectors/assets.js"

const MANAGED_ROOT = "confluence"

export type ConfluenceStorageMedia =
  | {
      kind: "attachment"
      filename: string
      asImage: boolean
      alt: string
    }
  | {
      kind: "external"
      url: string
      asImage: boolean
      alt: string
    }

type ConfluenceStorageMatchMedia =
  | ConfluenceStorageMedia
  | {
      kind: "link"
      url: string
      alt: string
    }

export type ConfluenceMediaResolution =
  | { status: "ok"; href: string }
  | {
      status: "stub"
      reason:
        | "asset_limit"
        | "entity_limit"
        | "download_failed"
        | "unsafe_url"
        | "invalid_url"
    }

const MEDIA_PLACEHOLDER_PREFIX = "@@CTXPIPE_MEDIA_"

export function confluencePageAssetPrefix(
  spaceKey: string,
  pageId: string,
): string {
  return `${MANAGED_ROOT}/${spaceKey}/_assets/${pageId}/`
}

export function confluencePageAssetPath(input: {
  spaceKey: string
  pageId: string
  sourceKey: string
  filename: string
}): string {
  return `${confluencePageAssetPrefix(input.spaceKey, input.pageId)}${input.sourceKey}--${sanitizeConnectorAssetName(input.filename)}`
}

export function relativeConfluenceAssetHref(
  markdownPath: string,
  assetPath: string,
): string {
  return pathPosix.relative(pathPosix.dirname(markdownPath), assetPath)
}

export function confluenceExternalSourceKey(url: string): string {
  return createHash("sha1")
    .update(canonicalConnectorAssetUrl(url))
    .digest("hex")
    .slice(0, 12)
}

export function confluenceMediaStub(input: {
  label: string
  reason: Extract<ConfluenceMediaResolution, { status: "stub" }>["reason"]
}): string {
  switch (input.reason) {
    case "asset_limit":
      return `[omitted: ${input.label} (exceeds 25 MiB)]`
    case "entity_limit":
      return `[omitted: ${input.label} (page exceeds 100 MiB of attachments)]`
    case "unsafe_url":
    case "invalid_url":
      return `[omitted: ${input.label} (unsafe URL)]`
    default:
      return `[omitted: ${input.label} (download failed)]`
  }
}

export type ConfluencePageTreeNode = {
  id: string
  title: string
  parentId: string | null
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi,
    (entity, encoded: string) => {
      const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"',
      }
      const normalised = encoded.toLowerCase()
      if (normalised in named) return named[normalised] ?? entity
      const radix = normalised.startsWith("#x") ? 16 : 10
      const digits = normalised.slice(radix === 16 ? 2 : 1)
      const codePoint = Number.parseInt(digits, radix)
      if (
        !Number.isFinite(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return entity
      }
      return String.fromCodePoint(codePoint)
    },
  )
}

function attrValue(attrs: string, name: string): string | undefined {
  const match = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"),
  )
  return match?.[1] === undefined ? undefined : decodeXmlEntities(match[1])
}

function attachmentFilename(inner: string): string | undefined {
  return attrValue(inner, "ri:filename")
}

function explicitExternalUrl(inner: string): string | undefined {
  const urlTag = inner.match(/<ri:url\b([^>]*)\/?\s*>/i)
  if (!urlTag) return undefined
  return attrValue(urlTag[1] ?? "", "ri:value")
}

function linkBodyText(inner: string): string | undefined {
  const cdata = inner.match(
    /<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>/i,
  )
  if (cdata?.[1] !== undefined) return cdata[1]
  const body = inner.match(/<ac:link-body>([\s\S]*?)<\/ac:link-body>/i)
  const text = body?.[1]?.replace(/<[^>]+>/g, "").trim()
  return text ? decodeXmlEntities(text) : undefined
}

function mediaFromInner(
  inner: string,
  attrs: string,
  asImage: boolean,
  fallbackAlt: string,
  externalKind: "external" | "link",
): ConfluenceStorageMatchMedia | undefined {
  const filename = attachmentFilename(inner)
  const alt =
    attrValue(attrs, "ac:alt") ||
    attrValue(attrs, "ac:title") ||
    linkBodyText(inner) ||
    filename ||
    fallbackAlt
  if (filename) {
    return { kind: "attachment", filename, asImage, alt }
  }
  const url = explicitExternalUrl(inner)
  if (url) {
    return externalKind === "link"
      ? { kind: "link", url, alt }
      : { kind: "external", url, asImage, alt }
  }
  return undefined
}

function renderResolvedMedia(
  media: ConfluenceStorageMedia,
  resolved: ConfluenceMediaResolution,
): string {
  if (resolved.status === "stub") {
    return confluenceMediaStub({ label: media.alt, reason: resolved.reason })
  }
  if (media.asImage) return `![${media.alt}](${resolved.href})`
  return `[${media.alt}](${resolved.href})`
}

type StorageMediaMatch = {
  start: number
  end: number
  block: boolean
  media: ConfluenceStorageMatchMedia
}

function collectStorageMedia(bodyStorage: string): StorageMediaMatch[] {
  const matches: StorageMediaMatch[] = []
  const patterns: Array<{
    regex: RegExp
    asImage: boolean
    block: boolean
    fallbackAlt: string
    externalKind: "external" | "link"
    filter?: (attrs: string) => boolean
  }> = [
    {
      regex: /<ac:image\b([^>]*)>([\s\S]*?)<\/ac:image>/gi,
      asImage: true,
      block: true,
      fallbackAlt: "image",
      externalKind: "external",
    },
    {
      regex: /<ac:link\b([^>]*)>([\s\S]*?)<\/ac:link>/gi,
      asImage: false,
      block: false,
      fallbackAlt: "attachment",
      externalKind: "link",
    },
    {
      regex:
        /<ac:structured-macro\b([^>]*)>([\s\S]*?)<\/ac:structured-macro>/gi,
      asImage: false,
      block: true,
      fallbackAlt: "attachment",
      externalKind: "external",
      filter: (attrs) => /\bac:name\s*=\s*["']view-file["']/i.test(attrs),
    },
  ]
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0
    let found = pattern.regex.exec(bodyStorage)
    while (found) {
      const attrs = found[1] ?? ""
      if (!pattern.filter || pattern.filter(attrs)) {
        const inner = found[2] ?? ""
        const media = mediaFromInner(
          inner,
          attrs,
          pattern.asImage,
          pattern.fallbackAlt,
          pattern.externalKind,
        )
        if (media) {
          matches.push({
            start: found.index,
            end: found.index + found[0].length,
            block: pattern.block,
            media,
          })
        }
      }
      found = pattern.regex.exec(bodyStorage)
    }
  }
  matches.sort((a, b) => a.start - b.start)
  const deduped: StorageMediaMatch[] = []
  for (const match of matches) {
    const overlapping = deduped.some(
      (existing) => match.start < existing.end && match.end > existing.start,
    )
    if (!overlapping) deduped.push(match)
  }
  return deduped
}

function htmlToMarkdown(
  input: string,
  resolveMedia?: (media: ConfluenceStorageMedia) => ConfluenceMediaResolution,
): string {
  const mediaMatches = collectStorageMedia(input)
  const replacements: string[] = []
  let withPlaceholders = ""
  let cursor = 0
  for (const [index, match] of mediaMatches.entries()) {
    withPlaceholders += input.slice(cursor, match.start)
    const rendered =
      match.media.kind === "link"
        ? `[${match.media.alt}](${match.media.url})`
        : resolveMedia === undefined
          ? ""
          : renderResolvedMedia(match.media, resolveMedia(match.media))
    replacements[index] = match.block ? `\n\n${rendered}\n\n` : rendered
    withPlaceholders += `${MEDIA_PLACEHOLDER_PREFIX}${index}@@`
    cursor = match.end
  }
  withPlaceholders += input.slice(cursor)

  const withLineBreaks = withPlaceholders
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr)>/gi, "\n")
  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, "")
  const decoded = decodeXmlEntities(withoutTags).replaceAll("&nbsp;", " ")
  const restored = decoded.replace(
    new RegExp(`${MEDIA_PLACEHOLDER_PREFIX}(\\d+)@@`, "g"),
    (_full, index: string) => replacements[Number(index)] ?? "",
  )
  return restored
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

function pageDirectorySegment(pageId: string): string {
  return `page--${pageId}`
}

function pageLeafFileName(title: string, pageId: string): string {
  return `${titleSlug(title)}--${pageId}.md`
}

/**
 * True for managed Confluence Markdown owned by `pageId`:
 * `…/<slug>--<pageId>.md` or `…/<dir>--<pageId>/index.md`.
 * Directory segments are immutable (`page--<pageId>/`); title-derived
 * leftovers (`parent/`, `parent--<pageId>/`) are pruned by a full reconcile.
 */
export function isManagedConfluenceMarkdownForPage(
  path: string,
  pageId: string,
): boolean {
  if (!path.startsWith(`${MANAGED_ROOT}/`) || path.includes("/_assets/")) {
    return false
  }
  const escaped = pageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?:^|/)${escaped === "" ? "(?!)" : `[^/]+--${escaped}`}(?:\\.md|/index\\.md)$`,
  ).test(path)
}

/**
 * Title-only leftovers such as `design/index.md` cannot be attributed to a
 * page id without reading the blob. A partial full reconcile must keep them.
 */
export function isAmbiguousLegacyConfluenceMarkdown(path: string): boolean {
  if (
    !path.startsWith(`${MANAGED_ROOT}/`) ||
    path.includes("/_assets/") ||
    path === `${MANAGED_ROOT}/config.yaml` ||
    !path.endsWith(".md")
  ) {
    return false
  }
  return !/(?:^|\/)[^/]+--[^/]+(?:\.md|\/index\.md)$/.test(path)
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
  const childrenByParent = buildChildrenByParent(input.pages)
  const anc = ancestorPageIds(input.pageId, pagesById, pathRootSkipPageIds)
  const prefixSegs: string[] = []
  for (const id of anc) {
    const ancestor = pagesById.get(id)
    if (!ancestor) {
      throw new Error(
        `Confluence sync: missing path segment for ancestor page ${id}`,
      )
    }
    prefixSegs.push(pageDirectorySegment(ancestor.id))
  }
  const self = pagesById.get(input.pageId)
  if (!self) {
    throw new Error(
      `Confluence sync: missing path segment for page ${input.pageId}`,
    )
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
    return `${prefix}${pageDirectorySegment(self.id)}/index.md`
  }
  return `${prefix}${pageLeafFileName(self.title, self.id)}`
}

export function extractConfluenceStorageMedia(
  bodyStorage: string,
): ConfluenceStorageMedia[] {
  return collectStorageMedia(bodyStorage)
    .map((match) => match.media)
    .filter((media): media is ConfluenceStorageMedia => media.kind !== "link")
}

export function toConfluenceMarkdownFile(input: {
  spaceKey: string
  pageId: string
  title: string
  bodyStorage: string
  pages: ConfluencePageTreeNode[]
  selectedIds: Set<string>
  pathRootSkipPageIds?: Set<string>
  resolveMedia?: (media: ConfluenceStorageMedia) => ConfluenceMediaResolution
  additionalAttachments?: Array<{
    label: string
    resolution: ConfluenceMediaResolution
  }>
}): { path: string; content: string } {
  const path = buildConfluenceMarkdownRelPath({
    spaceKey: input.spaceKey,
    pageId: input.pageId,
    pages: input.pages,
    selectedIds: input.selectedIds,
    pathRootSkipPageIds: input.pathRootSkipPageIds,
  })
  const body = htmlToMarkdown(input.bodyStorage, input.resolveMedia)
  const additionalAttachments = (input.additionalAttachments ?? []).map(
    ({ label, resolution }) =>
      renderResolvedMedia(
        {
          kind: "attachment",
          filename: label,
          asImage: false,
          alt: label,
        },
        resolution,
      ),
  )
  const content = `${[
    `# ${input.title}`,
    body,
    ...(additionalAttachments.length > 0
      ? ["## Attachments", ...additionalAttachments]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n")}\n`
  return { path, content }
}

export function getManagedConfluenceRootPath(): string {
  return `${MANAGED_ROOT}/`
}
