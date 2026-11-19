import { connectorMirrorRoot } from "../domain/codeIngestion/connectorMirrorPaths.js"
import { normalizeValidityBound } from "../domain/workspaces/hydrate-phases.js"
import {
  type HydrateUnit,
  markdownLinks,
  resolveHydrateLink,
  servingIdForKnowledgePath,
  unitRelations,
} from "../domain/workspaces/hydrate.js"
import { knowledgeChunkRows } from "../domain/workspaces/knowledge-chunks.js"
import { imageContentType } from "../domain/workspaces/raw-file.js"
import { workspaceGraphNodes } from "../domain/workspaces/workspace-graph.js"
import type {
  DocumentRows,
  KnowledgeChunk,
  KnowledgeRelation,
} from "../knowledge-store/knowledge-store.js"

/** The rows of one document before the embedding step adds the vectors. */
export type UnembeddedDocumentRows = Omit<DocumentRows, "chunks"> & {
  chunks: Omit<KnowledgeChunk, "embedding">[]
}

/**
 * Map one parsed Workspace file to its knowledge rows (ADR-066 decision 3):
 * the `active` document of the file, with its chunks and its outgoing
 * relations. The function writes nothing, and the same input gives the same
 * rows in the same order. The rows hold no org and no Workspace:
 * `KnowledgeStore` sets them (decision 9).
 *
 * A relation does not need a target row. Its target is the document key of
 * the resolved path, and the read resolves it (ADR-066 decision 5). Each
 * shown image has an `EMBEDS_IMAGE` relation to the key of its path. The
 * image document comes from the image file (`imageRows`).
 *
 * The rows depend only on the unit. Give a unit from `parseKnowledgeFile`,
 * which parses one file alone (CTX-1400), and after
 * `applyEffectiveValidFromToUnits`. A validity bound that is not a time (for
 * example a Git SHA) becomes null.
 */
export function knowledgeRows(input: {
  workspaceId: string
  unit: HydrateUnit
  /**
   * The Workspace path of a blob URL of the Workspace repository
   * (`workspaceBlobPath`), so that an image or a link with such a URL has a
   * target. Without it, a URL has no target.
   */
  blobPath?: (url: string) => string | null
  observedAt: Date
}): UnembeddedDocumentRows {
  const { workspaceId, unit, observedAt } = input
  const dir = unit.path.split("/").slice(0, -1).join("/")
  const keyOf = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  /**
   * A Markdown link destination without its optional title. A destination in
   * angle brackets can hold spaces.
   */
  const withoutTitle = (href: string) => {
    const trimmed = href.trim()
    return (
      (trimmed.startsWith("<")
        ? /^<([^>]*)>/.exec(trimmed)?.[1]
        : trimmed.split(/\s+/)[0]) ?? ""
    )
  }
  const targetOf = (href: string) => {
    const destination = withoutTitle(href)
    return /^https?:/i.test(destination)
      ? (input.blobPath?.(destination) ?? "")
      : resolveHydrateLink(dir, destination)
  }
  const node = workspaceGraphNodes([unit])[0]
  if (!node) throw new Error(`No graph node for ${unit.path}`)
  const title = unit.title ?? node.name ?? ""

  // The rows hold no chunk hash, so the embedding model is not an input here.
  const chunks = knowledgeChunkRows([unit], "").map(
    ({ ordinal, text, startLine, endLine }) => ({
      ordinal,
      text,
      startLine,
      endLine,
    }),
  )
  // A file with no body text (only front matter) gets one chunk with its
  // title, so that each relation has a chunk that states it. Its lines are
  // the first line of the file, where the front matter starts.
  if (!chunks.length)
    chunks.push({ ordinal: 0, text: title, startLine: 1, endLine: 1 })
  // The link definitions of the body (`[label]: path "title"`), for a
  // reference-style image (`![alt][label]`, `![label][]` or `![label]`).
  const definitions = new Map(
    Array.from(
      withoutFencedCode(unit.body).matchAll(
        /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)/gm,
      ),
      (match) => [match[1]?.toLowerCase() ?? "", match[2] ?? ""] as const,
    ),
  )
  /**
   * The image targets of a text: inline and reference-style images, outside
   * fenced code.
   */
  const imagesOf = (raw: string) => {
    const text = withoutFencedCode(raw)
    return [
      ...Array.from(text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (m) => m[1]),
      ...Array.from(
        text.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\]|(?![([]))/g),
        (m) => definitions.get((m[2] || m[1] || "").toLowerCase()),
      ),
    ].flatMap((href) => {
      const target = href ? targetOf(href) : ""
      return target && imageContentType(target) ? [target] : []
    })
  }
  const chunkLinks = chunks.map((chunk) => [
    ...markdownLinks(chunk.text).map(targetOf),
    ...imagesOf(chunk.text),
  ])
  // A claim is in the front matter, so no chunk states it, and a mirror
  // reference link is in no Markdown link of the body. Such a relation takes
  // the first chunk that links to its target, else the first chunk.
  const chunkOf = (target: string) =>
    Math.max(
      0,
      chunkLinks.findIndex((targets) => targets.includes(target)),
    )

  const images = new Set(imagesOf(unit.body))

  // The target is a Workspace path now. CTX-1400 adds a reference key (for
  // example a Linear identifier) that the read resolves.
  const relation = (
    target: string,
    row: Pick<KnowledgeRelation, "predicate" | "confidence" | "source"> &
      Partial<Pick<KnowledgeRelation, "validFrom" | "validTo">>,
  ): Omit<KnowledgeRelation, "srcDoc"> => ({
    srcChunk: chunkOf(target),
    dstDoc: keyOf(target),
    validFrom: null,
    validTo: null,
    observedAt,
    ...row,
  })
  // The target of a body link with a title keeps the title, so the link
  // relations use the path without it. An image gets its own relation below,
  // not a second `LINKS_TO`.
  const linked = new Set<string>()
  const relations = unitRelations(unit).flatMap((entry) => {
    const target =
      entry.from === "claim" ? entry.target : withoutTitle(entry.target)
    if (entry.from === "link") {
      if (images.has(target) || linked.has(target)) return []
      linked.add(target)
    }
    return [
      relation(target, {
        predicate: entry.predicate,
        confidence: entry.confidence,
        validFrom: dateOrNull(normalizeValidityBound(entry.validFrom)),
        validTo: dateOrNull(normalizeValidityBound(entry.validTo)),
        source: entry.source ?? "",
      }),
    ]
  })

  for (const target of images)
    relations.push(
      relation(target, {
        predicate: "EMBEDS_IMAGE",
        confidence: 1,
        source: "git",
      }),
    )

  return {
    document: {
      ...documentDefaults(observedAt),
      docKey: unit.servingId,
      kind: node.kind,
      title,
      path: unit.path,
      sourceType: sourceAuthority(unit),
      summary: node.summary ?? "",
    },
    chunks,
    relations,
  }
}

/**
 * The rows of the `image` document of the image file at `path`, whose bytes
 * have the SHA-256 `hash` (hex). Only the hash makes the S3 key, never text
 * from a file (ADR-066 decision 6).
 */
export function imageRows(input: {
  orgId: string
  workspaceId: string
  path: string
  hash: string
  observedAt: Date
}): UnembeddedDocumentRows {
  const { path, hash, observedAt } = input
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new Error(`The image hash of ${path} is not a SHA-256 hex digest`)
  return {
    document: {
      ...documentDefaults(observedAt),
      docKey: servingIdForKnowledgePath(input.workspaceId, path),
      kind: "image",
      title: path.slice(path.lastIndexOf("/") + 1),
      path,
      sourceType: sourceAuthority({ path }),
      s3Key: `${input.orgId}/${input.workspaceId}/${hash}`,
      // The embedding step reads the type, and it decides how to send a
      // type that the model does not take (for example SVG).
      mime: imageContentType(path) ?? "",
    },
    // The image embedding is the vector of this chunk. Its text stays empty:
    // the alt text belongs to the file that shows the image, and two files
    // can give one image different alt texts (ADR-066 decision 5).
    chunks: [{ ordinal: 0, text: "", startLine: 0, endLine: 0 }],
    relations: [],
  }
}

/**
 * The source authority kinds, from the highest authority to the lowest. The
 * disagreement tie-break ranks `source_type` in this order. The kind `other`
 * is not in the list, so it ranks below all of them.
 */
export const SOURCE_AUTHORITY_ORDER = [
  "adr",
  "merged-pr",
  "docs",
  "issue",
  "open-pr",
  "chat",
] as const

/**
 * The source authority kind of a file. It comes from the file alone: its
 * path, its document kind, and the `merged` field of its front matter, which
 * the pull request mirror converter writes. The connector folder stays in
 * the path.
 */
function sourceAuthority(file: {
  path: string
  kind?: string | null
  merged?: boolean
}): (typeof SOURCE_AUTHORITY_ORDER)[number] | "other" {
  const [, folder] = file.path.split("/")
  switch (connectorMirrorRoot(file.path)) {
    case null: {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1)
      return file.kind?.toLowerCase() === "decision" || /^adr-\d/i.test(name)
        ? "adr"
        : "docs"
    }
    case "notion":
    case "confluence":
      return "docs"
    case "github":
      if (folder === "pulls") return file.merged ? "merged-pr" : "open-pr"
      return folder === "issues" ? "issue" : "other"
    case "linear":
    case "plain":
    case "pagerduty":
      return "issue"
    case "slack":
      return "chat"
    default:
      return "other"
  }
}

function documentDefaults(observedAt: Date) {
  return {
    source: "",
    summary: "",
    s3Key: "",
    mime: "",
    validFrom: null,
    validTo: null,
    observedAt,
  }
}

/** The text with each line of a fenced code block made empty. */
function withoutFencedCode(text: string): string {
  let fence: string | null = null
  return text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence) {
        if (
          marker !== undefined &&
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          line.trim() === marker
        )
          fence = null
        return ""
      }
      if (marker) fence = marker
      return marker ? "" : line
    })
    .join("\n")
}

function dateOrNull(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso)
}
