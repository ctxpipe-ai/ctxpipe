import { connectorMirrorRoot } from "../domain/codeIngestion/connectorMirrorPaths.js"
import { normalizeValidityBound } from "../domain/workspaces/graph-projection.js"
import {
  type HydrateUnit,
  markdownLinks,
  resolveHydrateLink,
  servingIdForKnowledgePath,
} from "../domain/workspaces/hydrate.js"
import { knowledgeChunkRows } from "../domain/workspaces/knowledge-chunks.js"
import { workspaceGraphNodes } from "../domain/workspaces/workspace-graph.js"

/**
 * The rows of the three knowledge tables (ADR-066 decision 3). The rows hold
 * no `org_id` and no `workspace_id`: the `KnowledgeStore` write API sets them
 * (decision 9). The chunk rows hold no vectors: the embedding step adds them.
 * A time is an ISO 8601 UTC string.
 */
export type DocumentRow = {
  /** The stable key of the document: `servingIdForKnowledgePath` of its path. */
  doc_id: string
  status: "active" | "deleted" | "missing" | "failed"
  deleted_at: string | null
  error: string | null
  kind: string
  title: string | null
  path: string
  /** The connector root of the path (`linear`, …), else `authored`. */
  source_type: string
  source: string | null
  summary: string | null
  /**
   * For an image only: `{org_id}/{workspace_id}/<SHA-256 of the bytes>`. The
   * writer replaces the two placeholders with the org and the Workspace of
   * the write (ADR-066 decision 6).
   */
  s3_key: string | null
  mime: string | null
  valid_from: string | null
  valid_to: string | null
  observed_at: string
}

export type ChunkRow = {
  doc_id: string
  ordinal: number
  text: string
}

export type RelationRow = {
  src_doc: string
  /** The ordinal of the chunk of `src_doc` that states the relation. */
  src_chunk: number
  predicate: string
  /** A document key. The read resolves it; the target can have no row yet. */
  dst_doc: string
  confidence: number
  valid_from: string | null
  valid_to: string | null
  source: string | null
  observed_at: string
}

export type KnowledgeRows = {
  documents: DocumentRow[]
  chunks: ChunkRow[]
  relations: RelationRow[]
}

/** The raster types that the embedding model and Jev read. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** The predicate of the relation from a file to an image that it shows. */
const EMBEDS_IMAGE_PREDICATE = "EMBEDS_IMAGE"

const MD_IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g

/**
 * Map one parsed Workspace file to its knowledge rows: one `active` document,
 * its chunks, its outgoing relations, and one `image` document for each
 * image that it shows. The function writes nothing, and the same input gives
 * the same rows in the same order.
 *
 * The relations follow the rules of `hydrateUnitsToProjectionClaims`, with one
 * difference: a relation does not need a target row. Its target is the
 * document key of the resolved path, and the read resolves it (ADR-066
 * decision 5).
 *
 * Give the unit after `applyEffectiveValidFromToUnits`. A validity bound that
 * is not a time (for example a Git SHA) becomes null.
 */
export function knowledgeRows(input: {
  workspaceId: string
  unit: HydrateUnit
  /**
   * The SHA-256 (hex) of the bytes of each image file, by its Workspace path.
   * An image with no hash has no image document: its relation then points at
   * a key with no row, as a link to a file that is not in Git does.
   */
  imageHashes: ReadonlyMap<string, string>
  observedAt: string
}): KnowledgeRows {
  const { workspaceId, unit, imageHashes, observedAt } = input
  const docId = unit.servingId
  const dir = unit.path.split("/").slice(0, -1).join("/")
  const keyOf = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const [node] = workspaceGraphNodes([unit])

  // The rows hold no chunk hash, so the embedding model is not an input here.
  const chunks: ChunkRow[] = knowledgeChunkRows([unit], "").map((chunk) => ({
    doc_id: docId,
    ordinal: chunk.ordinal,
    text: chunk.text,
  }))
  const chunkLinks = chunks.map((chunk) =>
    markdownLinks(chunk.text).map((href) => resolveHydrateLink(dir, href)),
  )
  /** The first chunk that links to the target, else the first chunk. */
  const chunkOf = (target: string) =>
    Math.max(
      0,
      chunkLinks.findIndex((targets) => targets.includes(target)),
    )

  const images = new Map<string, string>()
  for (const match of unit.body.matchAll(MD_IMAGE)) {
    const target = resolveHydrateLink(dir, match[2]?.trim() ?? "")
    if (!imageMime(target) || images.has(target)) continue
    images.set(target, match[1]?.trim() ?? "")
  }

  const relations: RelationRow[] = []
  const relation = (
    target: string,
    row: Pick<RelationRow, "predicate" | "confidence" | "source"> &
      Partial<Pick<RelationRow, "valid_from" | "valid_to">>,
  ) =>
    relations.push({
      src_doc: docId,
      src_chunk: chunkOf(target),
      dst_doc: keyOf(target),
      valid_from: null,
      valid_to: null,
      observed_at: observedAt,
      ...row,
    })

  const bodyTargets = new Set(
    unit.links.map((href) => resolveHydrateLink(dir, href)),
  )
  // A claim is in the front matter, so no chunk states it. It takes the first
  // chunk that links to its target, else the first chunk (ordinal 0).
  for (const claim of unit.claims) {
    const target = resolveHydrateLink(dir, claim.to)
    if (!target) continue
    // A predicate-less claim adds no second layer over the permanent body link.
    if (!claim.predicate && bodyTargets.has(target)) continue
    relation(target, {
      predicate: claim.predicate || "LINKS_TO",
      confidence: claim.confidence ?? unit.confidence ?? 0.5,
      valid_from: normalizeValidityBound(claim.validFrom),
      valid_to: normalizeValidityBound(claim.validTo),
      source: claim.source,
    })
  }
  // A reference link that the mirror adds (`workspace:` scheme) is in no
  // Markdown link of the body, so it takes the first chunk.
  const linked = new Set<string>()
  for (const href of unit.links) {
    const target = resolveHydrateLink(dir, href)
    if (!target || linked.has(target) || images.has(target)) continue
    linked.add(target)
    relation(target, { predicate: "LINKS_TO", confidence: 1, source: "git" })
  }

  const documents: DocumentRow[] = [
    {
      ...documentDefaults(observedAt),
      doc_id: docId,
      kind: node?.kind ?? "KnowledgeUnit",
      title: unit.title ?? node?.name ?? null,
      path: unit.path,
      source_type: unit.source,
      summary: node?.summary ?? null,
    },
  ]
  for (const [target, alt] of images) {
    relation(target, {
      predicate: EMBEDS_IMAGE_PREDICATE,
      confidence: 1,
      source: "git",
    })
    const hash = imageHashes.get(target)
    if (hash === undefined) continue
    // Only the hash makes the key, never text from the file (ADR-066 decision 6).
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`The image hash of ${target} is not a SHA-256 hex digest`)
    const imageId = keyOf(target)
    documents.push({
      ...documentDefaults(observedAt),
      doc_id: imageId,
      kind: "image",
      title: target.split("/").at(-1) ?? target,
      path: target,
      source_type: connectorMirrorRoot(target) ?? "authored",
      s3_key: `{org_id}/{workspace_id}/${hash}`,
      mime: imageMime(target),
    })
    // The text of an image chunk is its alt text. The image embedding is its
    // vector. The alt text of the first reference in this file wins.
    chunks.push({ doc_id: imageId, ordinal: 0, text: alt })
  }

  return { documents, chunks, relations }
}

function documentDefaults(observedAt: string) {
  return {
    status: "active" as const,
    deleted_at: null,
    error: null,
    source: null,
    summary: null,
    s3_key: null,
    mime: null,
    valid_from: null,
    valid_to: null,
    observed_at: observedAt,
  }
}

function imageMime(path: string): string | null {
  const name = path.split("/").at(-1) ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0
    ? (IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null)
    : null
}
