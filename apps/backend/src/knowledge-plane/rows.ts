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
import { inlineImageType } from "../domain/workspaces/raw-file.js"
import { workspaceGraphNodes } from "../domain/workspaces/workspace-graph.js"

// TEMPORARY copies of the types of `knowledge-store/knowledge-store.ts`
// (CTX-1392, PR #848). When that PR is on `main`, import them from there and
// delete these copies.
type KnowledgeDocument = {
  docKey: string
  kind: string
  status: "active" | "deleted" | "missing" | "failed"
  deletedAt: Date | null
  error: string
  title: string
  path: string
  sourceType: string
  source: string
  summary: string
  s3Key: string
  mime: string
  validFrom: Date | null
  validTo: Date | null
  observedAt: Date
}

type KnowledgeChunk = {
  ordinal: number
  text: string
  embedding: number[]
}

type KnowledgeRelation = {
  srcDoc: string
  srcChunk: number
  predicate: string
  dstDoc: string
  confidence: number
  validFrom: Date | null
  validTo: Date | null
  source: string
  observedAt: Date
}

type DocumentRows = {
  document: KnowledgeDocument
  chunks: KnowledgeChunk[]
  relations: Omit<KnowledgeRelation, "srcDoc">[]
}

/** The rows of one document before the embedding step adds the vectors. */
type UnembeddedDocumentRows = Omit<DocumentRows, "chunks"> & {
  chunks: Omit<KnowledgeChunk, "embedding">[]
}

/**
 * Map one parsed Workspace file to its knowledge rows (ADR-066 decision 3):
 * first the `active` document of the file, with its chunks and its outgoing
 * relations, then one `image` document for each image that the file shows.
 * The function writes nothing, and the same input gives the same rows in the
 * same order. The rows hold no org and no Workspace: `KnowledgeStore` sets
 * them (decision 9).
 *
 * A relation does not need a target row. Its target is the document key of
 * the resolved path, and the read resolves it (ADR-066 decision 5).
 *
 * Known gap: the parse (`hydrateKnowledgeTree`) reads the full tree for two
 * kinds of relation. A mirror reference link (`workspace:` scheme) and a
 * `FROM_SOURCE` claim are in the unit only when their target file is in the
 * tree. Thus the rows of a file can change when another file is added or
 * removed, and a writer that maps only the changed files must also map the
 * files that refer to them (CTX-1400).
 *
 * Give the unit after `applyEffectiveValidFromToUnits`. A validity bound that
 * is not a time (for example a Git SHA) becomes null.
 */
export function knowledgeRows(input: {
  workspaceId: string
  unit: HydrateUnit
  /**
   * For each image path that the file shows: the SHA-256 (hex) of its bytes,
   * or null when Git has no such file. An image with null has no image
   * document: its relation points at a key with no row, as a link to a file
   * that is not in Git does. A path with no entry is an error of the caller.
   */
  imageHashes: ReadonlyMap<string, string | null>
  observedAt: Date
}): UnembeddedDocumentRows[] {
  const { workspaceId, unit, imageHashes, observedAt } = input
  const dir = unit.path.split("/").slice(0, -1).join("/")
  const keyOf = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  /** A Markdown link destination without its optional title. */
  const withoutTitle = (href: string) =>
    href.trim().split(/\s+/)[0]?.replace(/^<|>$/g, "") ?? ""
  const targetOf = (href: string) => resolveHydrateLink(dir, withoutTitle(href))
  const node = workspaceGraphNodes([unit])[0]
  if (!node) throw new Error(`No graph node for ${unit.path}`)
  const title = unit.title ?? node.name ?? ""

  // The rows hold no chunk hash, so the embedding model is not an input here.
  const chunks = knowledgeChunkRows([unit], "").map(({ ordinal, text }) => ({
    ordinal,
    text,
  }))
  // A file with no body text (only front matter) gets one chunk with its
  // title, so that each relation has a chunk that states it.
  if (!chunks.length) chunks.push({ ordinal: 0, text: title })
  const chunkLinks = chunks.map((chunk) =>
    markdownLinks(chunk.text).map(targetOf),
  )
  // A claim is in the front matter, so no chunk states it, and a mirror
  // reference link is in no Markdown link of the body. Such a relation takes
  // the first chunk that links to its target, else the first chunk.
  const chunkOf = (target: string) =>
    Math.max(
      0,
      chunkLinks.findIndex((targets) => targets.includes(target)),
    )

  const images = new Set(
    Array.from(unit.body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (match) =>
      targetOf(match[1] ?? ""),
    ).filter((target) => inlineImageType(target)),
  )

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

  const imageDocuments: UnembeddedDocumentRows[] = []
  for (const target of images) {
    relations.push(
      relation(target, {
        predicate: "EMBEDS_IMAGE",
        confidence: 1,
        source: "git",
      }),
    )
    const hash = imageHashes.get(target)
    if (hash === undefined)
      throw new Error(`No image hash for ${target}, shown by ${unit.path}`)
    if (hash === null) continue
    // Only the hash makes the key, never text from the file (ADR-066 decision 6).
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`The image hash of ${target} is not a SHA-256 hex digest`)
    imageDocuments.push({
      document: {
        ...documentDefaults(observedAt),
        docKey: keyOf(target),
        kind: "image",
        title: target.slice(target.lastIndexOf("/") + 1),
        path: target,
        sourceType: connectorMirrorRoot(target) ?? "authored",
        // The writer replaces the two placeholders with the org and the
        // Workspace of the write.
        s3Key: `{org_id}/{workspace_id}/${hash}`,
        mime: inlineImageType(target) ?? "",
      },
      // The image embedding is the vector of this chunk. Its text stays empty:
      // the alt text belongs to the file that shows the image, and two files
      // can give one image different alt texts (ADR-066 decision 5).
      chunks: [{ ordinal: 0, text: "" }],
      relations: [],
    })
  }

  return [
    {
      document: {
        ...documentDefaults(observedAt),
        docKey: unit.servingId,
        kind: node.kind,
        title,
        path: unit.path,
        sourceType: unit.source,
        summary: node.summary ?? "",
      },
      chunks,
      relations,
    },
    ...imageDocuments,
  ]
}

function documentDefaults(observedAt: Date) {
  return {
    status: "active" as const,
    deletedAt: null,
    error: "",
    source: "",
    summary: "",
    s3Key: "",
    mime: "",
    validFrom: null,
    validTo: null,
    observedAt,
  }
}

function dateOrNull(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso)
}
