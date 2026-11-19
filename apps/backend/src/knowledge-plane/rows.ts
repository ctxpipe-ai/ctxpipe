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

/**
 * The rows of the three knowledge tables (ADR-066 decision 3). The rows hold
 * no `org_id` and no `workspace_id`: the `KnowledgeStore` write API sets them
 * (decision 9). The chunk rows hold no vectors: the embedding step adds them.
 * A time is an ISO 8601 UTC string.
 */
type DocumentRow = {
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

type ChunkRow = {
  doc_id: string
  ordinal: number
  text: string
}

type RelationRow = {
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

const MD_IMAGE = /!\[[^\]]*\]\(([^)]+)\)/g

/**
 * Map one parsed Workspace file to its knowledge rows: one `active` document,
 * its chunks, its outgoing relations, and one `image` document for each
 * image that it shows. The function writes nothing, and the same input gives
 * the same rows in the same order.
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
   * The SHA-256 (hex) of the bytes of each image file, by its Workspace path.
   * An image with no hash has no image document: its relation then points at
   * a key with no row, as a link to a file that is not in Git does.
   */
  imageHashes: ReadonlyMap<string, string>
  observedAt: string
}): { documents: DocumentRow[]; chunks: ChunkRow[]; relations: RelationRow[] } {
  const { workspaceId, unit, imageHashes, observedAt } = input
  const docId = unit.servingId
  const dir = unit.path.split("/").slice(0, -1).join("/")
  const keyOf = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const node = workspaceGraphNodes([unit])[0] as ReturnType<
    typeof workspaceGraphNodes
  >[number]
  const title = unit.title ?? node.name

  // The rows hold no chunk hash, so the embedding model is not an input here.
  const chunks: ChunkRow[] = knowledgeChunkRows([unit], "").map((chunk) => ({
    doc_id: docId,
    ordinal: chunk.ordinal,
    text: chunk.text,
  }))
  // A file with no body text (only front matter) gets one chunk with its
  // title, so that each relation has a chunk that states it.
  if (!chunks.length)
    chunks.push({ doc_id: docId, ordinal: 0, text: title ?? "" })
  const chunkLinks = chunks.map((chunk) =>
    markdownLinks(chunk.text).map((href) => resolveHydrateLink(dir, href)),
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
    Array.from(unit.body.matchAll(MD_IMAGE), (match) =>
      resolveHydrateLink(dir, match[1]?.trim() ?? ""),
    ).filter((target) => inlineImageType(target)),
  )

  const relation = (
    target: string,
    row: Pick<
      RelationRow,
      "predicate" | "confidence" | "valid_from" | "valid_to" | "source"
    >,
  ): RelationRow => ({
    src_doc: docId,
    src_chunk: chunkOf(target),
    dst_doc: keyOf(target),
    observed_at: observedAt,
    ...row,
  })
  const relations = unitRelations(unit)
    // An image gets its own relation below, not a second `LINKS_TO`.
    .filter((entry) => entry.from === "claim" || !images.has(entry.target))
    .map((entry) =>
      relation(entry.target, {
        predicate: entry.predicate,
        confidence: entry.confidence,
        valid_from: normalizeValidityBound(entry.validFrom),
        valid_to: normalizeValidityBound(entry.validTo),
        source: entry.source,
      }),
    )

  const documents: DocumentRow[] = [
    {
      ...documentDefaults(observedAt),
      doc_id: docId,
      kind: node.kind,
      title,
      path: unit.path,
      source_type: unit.source,
      summary: node.summary,
    },
  ]
  for (const target of images) {
    relations.push(
      relation(target, {
        predicate: "EMBEDS_IMAGE",
        confidence: 1,
        valid_from: null,
        valid_to: null,
        source: "git",
      }),
    )
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
      title: target.slice(target.lastIndexOf("/") + 1),
      path: target,
      source_type: connectorMirrorRoot(target) ?? "authored",
      s3_key: `{org_id}/{workspace_id}/${hash}`,
      mime: inlineImageType(target),
    })
    // The image embedding is the vector of this chunk. Its text stays empty:
    // the alt text belongs to the file that shows the image, and two files can
    // give one image different alt texts (ADR-066 decision 5).
    chunks.push({ doc_id: imageId, ordinal: 0, text: "" })
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
