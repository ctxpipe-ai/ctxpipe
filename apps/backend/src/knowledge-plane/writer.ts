import { metrics, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

import { githubSourceRepositories } from "../domain/workspace-sources/github-sources.js"
import {
  isSourcesTreePath,
  SOURCES_FOLDER_PREFIX,
} from "../domain/workspace-sources/source-tree.js"
import { SOURCES_FILE_PATH } from "../domain/workspace-sources/sources-file.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import {
  type DocumentRows,
  type DocumentStatus,
  type KnowledgeScope,
  type KnowledgeStore,
  type MutationCounter,
  REFERENCE_TARGET_PREFIX,
} from "../knowledge-store/knowledge-store.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
  failKnowledgeRun,
  getKnowledgeState,
} from "../models/knowledge-state.js"
import { getLogger } from "../observability/logger.js"
import {
  type EmbeddingInput,
  embeddingKey,
  embedTexts,
  textEmbeddingConfig,
} from "../retrieval/embeddings/textEmbeddings.js"
import {
  fetchGitHistory,
  readMarkdownHistory,
} from "../services/git/clone-tree.js"
import {
  fetchGitCommits,
  nativeGit,
  readGitBlobSizes,
  readGitBlobs,
  withGitDirectory,
} from "../services/git/pack.js"
import { workspaceRelativePath } from "../services/git/root-folder.js"
import {
  type KnowledgeChangeSet,
  type KnowledgeFullReason,
  knowledgeProjectionVersion,
  planKnowledgeChangeSet,
} from "./change-set.js"
import {
  convertFile,
  converterVersion,
  type FileType,
  fileType,
} from "./convert-file.js"
import { type ImageTextCounter, imageTexts } from "./image-text.js"
import {
  isKnowledgePath,
  parseKnowledgeFile,
  workspaceBlobPath,
} from "./parse-file.js"
import { fileRows, knowledgeRows, type UnembeddedDocumentRows } from "./rows.js"

/** The Workspace repository and its read token. */
export type KnowledgeRemote = {
  url: string
  token: () => Promise<string | undefined>
}

/** What one run of the writer did. */
type KnowledgeRunSummary =
  /** `last_sha` is the tip, with the current projection version. */
  | { mode: "current" }
  | {
      mode: KnowledgeChangeSet["kind"]
      fullReason: KnowledgeFullReason | null
      /** The documents that the run replaced, made `failed` or made tombstones. */
      documentsChanged: number
      /** The `failed` documents of the Workspace after the run. */
      failedCount: number
    }

/**
 * The projection writer of the knowledge plane (ADR-067). It moves the
 * ClickHouse rows of one Workspace from `last_sha` to `tip`:
 * 1. `beginKnowledgeRun` adds the tip to `attempt_shas`.
 * 2. The planner gives the change set: a delta, or a full rebuild.
 * 3. Each changed document file replaces the rows of its document: a
 *    knowledge file (Markdown) or an image file (its key is its path). A
 *    knowledge file that does not parse gets a `failed` document. The
 *    `valid_from` of a knowledge file is the time of the commit that
 *    introduced it, from one walk of the Git history of the tip
 *    (`fileIntroductions`).
 * 4. Each relation target with no row gets a `missing` placeholder. A
 *    reference key target gets none: the read resolves it (ADR-066
 *    decision 5).
 * 5. Each document whose file is gone gets a tombstone. A full rebuild does
 *    this for each document that the tree does not give (the reconcile).
 * 6. `completeKnowledgeRun` moves `last_sha` to the tip.
 *
 * An infrastructure error (Git, ClickHouse, Postgres, the embedding API)
 * throws, and `failKnowledgeRun` records it. The retry applies the same
 * files again. The caller holds the knowledge projection lease of the
 * Workspace, so one run of a Workspace runs at a time.
 *
 * Before a file goes to the embedding model, the writer reads the stored
 * vectors of its document (`embedDocuments`): an input whose key
 * (`embeddingKey`) has a stored vector gets that vector, and only the other
 * inputs go to the model. Thus a full rebuild embeds only new content.
 *
 * The text chunks go to the embedding model in batches. An image file gets
 * a document with no chunk and no vector: ingest writes a text file beside
 * it, and that file is the searchable text (ADR-066 decision 6, ADR-068
 * decision 6). The writer reads no image bytes, and it stores no copy.
 */
export async function projectKnowledgePlane(input: {
  orgId: string
  workspaceId: string
  remote: KnowledgeRemote
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  tip: string
  /** A store with the writer user. */
  store: KnowledgeStore
  observedAt: Date
}): Promise<KnowledgeRunSummary> {
  const key = { orgId: input.orgId, workspaceId: input.workspaceId }
  const projectionVersion = knowledgeProjectionVersion({
    embeddingModel: textEmbeddingConfig.model,
    dimensions: textEmbeddingConfig.dimensions,
    root: input.root,
    converter: await converterVersion(),
  })
  const state = await getKnowledgeState(key)
  if (
    state?.lastSha === input.tip &&
    state.attemptShas.length === 0 &&
    state.projectionVersion === projectionVersion
  )
    return { mode: "current" }

  const started = performance.now()
  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan("knowledge.projection.apply", async (span) => {
      span.setAttributes({
        "ctxpipe.org.id": input.orgId,
        "ctxpipe.workspace.id": input.workspaceId,
      })
      let summary: KnowledgeRunSummary | undefined
      const counter: MutationCounter = { mutations: 0 }
      const embedding: EmbeddingCounter = {
        hits: 0,
        misses: 0,
        requests: 0,
        seconds: 0,
      }
      const files: FileCounter = {
        conversions: new Map(),
        images: { hits: 0, misses: 0, failures: 0, costUsd: 0 },
      }
      try {
        await beginKnowledgeRun({ ...key, tip: input.tip })
        summary = await withGitDirectory(
          input.tip,
          async (directory) => {
            const earlier = [
              ...(state?.lastSha ? [state.lastSha] : []),
              ...(state?.attemptShas ?? []),
            ]
            await fetchCommits(directory, input.remote, input.tip, earlier)
            const plan = await planKnowledgeChangeSet({
              directory,
              root: input.root,
              state,
              tip: input.tip,
              projectionVersion,
            })
            const documentsChanged = await applyChangeSet({
              ...input,
              directory,
              plan,
              introductions: await fileIntroductions({
                directory,
                remote: input.remote,
                root: input.root,
                tip: input.tip,
                earlier:
                  plan.kind === "delta"
                    ? [
                        ...(state?.lastSha ? [state.lastSha] : []),
                        ...(state?.attemptShas ?? []),
                      ]
                    : [],
              }),
              counter,
              embedding,
              files,
            })
            const failedCount = (
              await input.store.listDocumentKeys(key)
            ).filter((document) => document.status === "failed").length
            await completeKnowledgeRun({
              ...key,
              tip: input.tip,
              projectionVersion,
              failedCount,
            })
            return {
              mode: plan.kind,
              fullReason: plan.kind === "full" ? plan.reason : null,
              documentsChanged,
              failedCount,
            }
          },
          undefined,
          null,
        )
        return summary
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
        try {
          await failKnowledgeRun(key)
        } catch (stateError) {
          // The run error is the cause. The next run starts from the same
          // `last_sha` either way.
          getLogger().warn("Recording the failed knowledge run failed", {
            step: "knowledge-plane.writer",
            error: String(stateError),
          })
        }
        throw error
      } finally {
        recordRun({
          span,
          seconds: (performance.now() - started) / 1000,
          summary,
          mutations: counter.mutations,
          embedding,
          files,
        })
        span.end()
      }
    })
}

/**
 * The files of one store write. The store slices each IN list itself, so
 * this is only a memory bound: the rows of a group (with a vector of 1024
 * numbers for each chunk) stay in memory until its write, about 40 MB for
 * 1000 documents of 5 chunks.
 */
const FILES_PER_WRITE = 1000

/**
 * The work of one change set. Returns the count of changed documents.
 * `counter` gets the count of ClickHouse mutations.
 */
async function applyChangeSet(input: {
  orgId: string
  workspaceId: string
  remote: { url: string }
  root: string
  tip: string
  store: KnowledgeStore
  observedAt: Date
  directory: string
  plan: KnowledgeChangeSet
  introductions: FileIntroductions
  counter: MutationCounter
  embedding: EmbeddingCounter
  files: FileCounter
}): Promise<number> {
  const { workspaceId, root, store, observedAt, directory, plan } = input
  const scope: KnowledgeScope = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
  }
  const keyOf = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const isDocumentPath = (path: string) =>
    isKnowledgePath(path) || fileType(path) !== null
  const tree = await regularFiles(directory, input.tip, root)
  const blobPath = workspaceBlobPath(input.remote.url, root)
  const sourceRepositories = await sourceRepositoriesAt(
    directory,
    tree,
    input.remote.url,
  )
  // The status of each key. A key with a tombstone and an old row (a write
  // that stopped between the INSERT of the tombstone and the DELETE of the
  // old row) gives the old row, so that the run makes the tombstone again.
  const stored = new Map<string, DocumentStatus>()
  for (const { docKey, status } of await store.listDocumentKeys(scope))
    if (status !== "deleted" || !stored.has(docKey)) stored.set(docKey, status)
  // Only regular files: a submodule, a symlink or a removed path gives no
  // document. A delta also writes each file that a commit after a fork
  // added, because its `valid_from` can change when the diff does not show
  // it.
  const files = [
    ...new Set(
      plan.kind === "full"
        ? plan.files
        : [...plan.changed, ...input.introductions.addedSinceFork],
    ),
  ]
    .filter((path) => tree.has(path) && isDocumentPath(path))
    .sort()

  /** The keys of the documents that the run wrote from a file. */
  const written = new Set<string>()
  const targets = new Set<string>()
  let changed = 0
  // One store write for each group of files, so that a run makes few
  // mutations (ADR-066 decision 8). The last write has the tombstones and
  // the `missing` placeholders too, because they need the keys of all
  // groups. A run with no file makes one write for its tombstones.
  for (let at = 0; at === 0 || at < files.length; at += FILES_PER_WRITE) {
    const group = files.slice(at, at + FILES_PER_WRITE)
    const unembedded: UnembeddedDocumentRows[] = []
    const failed: { docKey: string; error: string }[] = []
    // The blobs are read 50 files at a time. The chunks of the whole group
    // then go to the embedding client in one call, so that its requests
    // fill to `batchSize`.
    await inBatches(group, 50, async (batch) => {
      const rows = await projectFiles({
        directory,
        keyOf,
        workspaceId,
        blobPath,
        sourceRepositories,
        observedAt,
        introducedAtByPath: input.introductions.introducedAtByPath,
        paths: batch,
        blobs: batch.map((path) => tree.get(path) ?? ""),
        store,
        scope,
        files: input.files,
      })
      unembedded.push(...rows.documents)
      failed.push(...rows.failed)
    })
    const documents = await embedDocuments(
      unembedded,
      store,
      scope,
      input.embedding,
    )
    for (const { document, relations } of documents) {
      written.add(document.docKey)
      for (const relation of relations)
        if (!relation.dstDoc.startsWith(REFERENCE_TARGET_PREFIX))
          targets.add(relation.dstDoc)
    }
    for (const { docKey } of failed) written.add(docKey)
    changed += documents.length + failed.length

    const last = at + FILES_PER_WRITE >= files.length
    // A tombstone for each document whose file is gone: in a delta, the
    // documents of the paths of the diff; in a full rebuild, each stored
    // document (the reconcile).
    const stale = !last
      ? []
      : (plan.kind === "full"
          ? [...stored.keys()]
          : [...plan.changed, ...plan.removed].filter(isDocumentPath).map(keyOf)
        ).filter((docKey) => {
          const status = stored.get(docKey)
          return (
            !written.has(docKey) && (status === "active" || status === "failed")
          )
        })
    const deleted = new Set(stale)
    // The store skips each target that has a row.
    const missing = !last
      ? []
      : [...targets].filter(
          (docKey) => !written.has(docKey) && !deleted.has(docKey),
        )
    await store.applyDocuments(
      scope,
      {
        documents,
        placeholders: [
          ...failed.map((row) => ({
            ...row,
            status: "failed" as const,
            observedAt,
          })),
          ...missing.map((docKey) => ({
            docKey,
            status: "missing" as const,
            observedAt,
          })),
        ],
        deleted: { docKeys: stale, deletedAt: observedAt },
      },
      input.counter,
    )
    changed += stale.length
  }
  return changed
}

/** The file conversions and the image texts of one run, for its metrics. */
type FileCounter = {
  /**
   * The count of each result (`text`, `image`, `unsupported`, `too-large` or
   * a failure of the converter) of each format.
   */
  conversions: Map<string, Map<string, number>>
  images: ImageTextCounter
}

/** The largest image that goes to the vision model. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/**
 * The largest other file that the writer reads. One git call gives at most
 * 64 MiB (`nativeGit`), with the header of each blob.
 */
const MAX_FILE_BYTES = 48 * 1024 * 1024
/** The bytes of the blobs of one git read, with their framing. */
const READ_BYTES = 32 * 1024 * 1024

/**
 * The rows of each file of `paths`, with no vectors: a document, or a
 * `failed` placeholder with the content error. A knowledge file that gives
 * no unit gives no row.
 *
 * A file that is not a knowledge file becomes text here, from its blob at
 * the tip (ADR-066 decision 6, CTX-1433): a document through the converter,
 * an image through the vision model and its cache (an SVG is first drawn to
 * a PNG). No text goes into Git. A file with no converter, or one that the
 * converter or the vision model cannot read, gets a `failed` document with
 * the reason.
 */
async function projectFiles(input: {
  directory: string
  /** The document key of a path. */
  keyOf: (path: string) => string
  workspaceId: string
  blobPath: ReturnType<typeof workspaceBlobPath>
  sourceRepositories: Map<string, string>
  observedAt: Date
  /** The time of the introducing commit of each path. */
  introducedAtByPath: ReadonlyMap<string, string>
  paths: string[]
  /** The blob id of each path. */
  blobs: string[]
  store: KnowledgeStore
  scope: KnowledgeScope
  files: FileCounter
}): Promise<{
  documents: UnembeddedDocumentRows[]
  failed: { docKey: string; error: string }[]
}> {
  const { workspaceId, keyOf, blobPath, observedAt } = input
  const documents: UnembeddedDocumentRows[] = []
  const failed: { docKey: string; error: string }[] = []
  const fail = (path: string, error: string) =>
    failed.push({ docKey: keyOf(path), error })
  type Entry = {
    path: string
    blob: string
    /** Null for a knowledge file. */
    type: Exclude<FileType, { kind: "unsupported" }> | null
  }
  const count = (format: string, result: string) => {
    const results = input.files.conversions.get(format) ?? new Map()
    results.set(result, (results.get(result) ?? 0) + 1)
    input.files.conversions.set(format, results)
  }
  const entries = input.paths.flatMap((path, index): Entry[] => {
    const blob = input.blobs[index] ?? ""
    if (isKnowledgePath(path)) return [{ path, blob, type: null }]
    const type = fileType(path)
    if (type?.kind === "unsupported") {
      fail(path, `No converter takes .${type.extension} files.`)
      count(type.extension, "unsupported")
      return []
    }
    return type ? [{ path, blob, type }] : []
  })
  // Each blob is read once, also when more paths have it.
  const entriesOf = new Map<string, Entry[]>()
  for (const entry of entries)
    entriesOf.set(entry.blob, [...(entriesOf.get(entry.blob) ?? []), entry])
  const blobs = [...entriesOf.keys()]
  // The size of each blob before a read: a file above its limit gets a
  // `failed` document, and each git read stays within the output limit.
  const sizes = await readGitBlobSizes(input.directory, blobs)
  const groups: string[][] = [[]]
  let groupBytes = 0
  for (const [index, blob] of blobs.entries()) {
    const size = sizes[index] ?? 0
    const shared = entriesOf.get(blob) ?? []
    const limit = shared.some((entry) => entry.type?.kind === "image")
      ? MAX_IMAGE_BYTES
      : MAX_FILE_BYTES
    if (size > limit) {
      for (const entry of shared) {
        fail(entry.path, `The file is larger than ${limit / 1024 / 1024} MiB.`)
        if (entry.type)
          count(
            entry.type.kind === "image" ? "image" : entry.type.format,
            "too-large",
          )
      }
      continue
    }
    // `cat-file --batch` adds a header line (`<sha> blob <size>`) and a
    // newline to each blob: 128 bytes is more than both.
    const bytes = size + 128
    if (groupBytes + bytes > READ_BYTES && (groups.at(-1)?.length ?? 0) > 0) {
      groups.push([])
      groupBytes = 0
    }
    groups.at(-1)?.push(blob)
    groupBytes += bytes
  }
  /** The images for the vision model, with the path and the type of each. */
  const images: {
    path: string
    mime: string
    blobSha: string
    image: { bytes: Buffer; mimeType: string }
    labels?: string
  }[] = []
  // The images of a group go to the vision step before the next read, so
  // the run holds the bytes of one group at a time.
  for (const group of groups) {
    const contents = await readGitBlobs(input.directory, group)
    for (const [index, blob] of group.entries())
      for (const { path, type } of entriesOf.get(blob) ?? [])
        await projectEntry(path, blob, type, contents[index] ?? Buffer.alloc(0))
    await projectImages()
  }
  return { documents, failed }

  async function projectEntry(
    path: string,
    blob: string,
    type: Entry["type"],
    bytes: Buffer,
  ): Promise<void> {
    if (type) {
      await projectFile({ path, blob, type, bytes })
      return
    }
    // The parse and the mapper read no Git and no network: an error here
    // is a content error of the file.
    try {
      const parsed = parseKnowledgeFile({
        workspaceId,
        blobPath,
        path,
        content: bytes.toString("utf8"),
        sourceRepositories: input.sourceRepositories,
      })
      if (parsed.kind === "failed") fail(path, parsed.error)
      if (parsed.kind === "unit")
        documents.push(
          knowledgeRows({
            workspaceId,
            unit: parsed.unit,
            references: parsed.references,
            blobPath,
            introducedAt: input.introducedAtByPath.get(path) ?? null,
            observedAt,
          }),
        )
    } catch (error) {
      fail(path, error instanceof Error ? error.message : String(error))
    }
  }

  async function projectFile(file: {
    path: string
    blob: string
    type: Exclude<FileType, { kind: "unsupported" }>
    bytes: Buffer
  }): Promise<void> {
    const { path, blob, type, bytes } = file
    if (type.kind === "image") {
      images.push({
        path,
        mime: type.mime,
        blobSha: blob,
        image: { bytes, mimeType: type.mime },
      })
      return
    }
    const conversion = await convertFile(type.format, bytes)
    count(
      type.format,
      conversion.kind === "failed" ? conversion.failure : conversion.kind,
    )
    if (conversion.kind === "failed")
      fail(path, `${conversion.failure}: ${conversion.message}`)
    else if (conversion.kind === "image")
      images.push({
        path,
        mime: type.mime,
        // The key of the cache is the SVG blob: the same SVG gives the same
        // PNG.
        blobSha: blob,
        image: { bytes: conversion.png, mimeType: "image/png" },
        labels: conversion.labels,
      })
    else
      documents.push(
        fileRows({
          workspaceId,
          path,
          kind: "document",
          mime: type.mime,
          text: conversion.text,
          summary: conversion.imageOnlyPages.length
            ? `The pages ${conversion.imageOnlyPages.join(", ")} have no text layer.`
            : "",
          observedAt,
        }),
      )
  }

  /** The texts of the images of `images`, which it then empties. */
  async function projectImages(): Promise<void> {
    if (images.length === 0) return
    const texts = await imageTexts({
      store: input.store,
      scope: input.scope,
      images,
      counter: input.files.images,
    })
    for (const { path, mime, blobSha } of images.splice(0)) {
      const text = texts.get(blobSha)
      if (!text || "error" in text)
        fail(path, text?.error ?? "The image has no text.")
      else
        documents.push(
          fileRows({
            workspaceId,
            path,
            kind: "image",
            mime,
            text: text.text,
            observedAt,
          }),
        )
    }
  }
}

/**
 * The repository URL of each GitHub source file of the tree, for the
 * `CHANGED` keys of a package file. A change of the sources starts a full
 * rebuild (ADR-067 decision 4), so each package file gets the new URLs.
 */
async function sourceRepositoriesAt(
  directory: string,
  tree: ReadonlyMap<string, string>,
  workspaceUrl: string,
): Promise<Map<string, string>> {
  const paths = [...tree.keys()].filter(isSourcesTreePath)
  if (paths.length === 0) return new Map()
  const blobs = await readGitBlobs(
    directory,
    paths.map((path) => tree.get(path) ?? ""),
  )
  const text = new Map(
    paths.map((path, index) => [path, blobs[index]?.toString("utf8") ?? ""]),
  )
  return new Map(
    githubSourceRepositories(
      text.get(SOURCES_FILE_PATH) ?? null,
      null,
      paths
        .filter((path) => path.startsWith(SOURCES_FOLDER_PREFIX))
        .map((path) => ({ path, text: text.get(path) ?? "" })),
      { workspaceUrl },
    )
      .filter((source) => source.path.startsWith(SOURCES_FOLDER_PREFIX))
      .map((source) => [source.path, source.gitUrl]),
  )
}

/** Call `call` for each batch of at most `size` items, in order. */
export async function inBatches<T>(
  items: readonly T[],
  size: number,
  call: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let at = 0; at < items.length; at += size)
    await call(items.slice(at, at + size))
}

/** The embedding work of one run, for its metrics. */
type EmbeddingCounter = {
  /** The chunks that got a stored vector. */
  hits: number
  /** The chunks with no stored vector. They go to the model. */
  misses: number
  /**
   * The HTTP requests to the embedding API, each retry too. Inputs of one
   * batch with the same key go in one request.
   */
  requests: number
  /** The time in the embedding API, in seconds. */
  seconds: number
}

/**
 * Embed the text chunks of each document, in batches (`embedTexts`). A chunk
 * with no text gets no vector. Each chunk gets its key (`embeddingKey`) and
 * the stored vector of that key in one of `documents`, if there is one. Only
 * the chunks with no stored vector go to the model, one for each key, and
 * chunks with the same key share that vector.
 *
 * The lookup reads only the chunks of these documents in the Workspace of
 * the run (ADR-067 decision 5). They are the rows that this write replaces,
 * before its DELETE, and the rows that an earlier write of the same file
 * gave. A stored vector is the BFloat16 value, so its write stores the same
 * value as a write of the new vector. `counter` gets the counts of the run.
 */
async function embedDocuments(
  documents: UnembeddedDocumentRows[],
  store: KnowledgeStore,
  scope: KnowledgeScope,
  counter: EmbeddingCounter,
): Promise<DocumentRows[]> {
  const inputs: EmbeddingInput[] = documents.flatMap(({ document, chunks }) =>
    chunks.flatMap((chunk, index) =>
      chunk.text.trim()
        ? [
            {
              kind: "text" as const,
              text: chunk.text,
              documentTitle: document.title,
              chunkIndex: index,
              chunkCount: chunks.length,
            },
          ]
        : [],
    ),
  )
  const keys = inputs.map((input) => embeddingKey(input, textEmbeddingConfig))
  const vectors = await store.readEmbeddings(
    scope,
    documents.map(({ document }) => document.docKey),
    keys,
  )
  const missing = new Map<string, EmbeddingInput>()
  for (const [index, input] of inputs.entries()) {
    const key = keys[index] ?? ""
    if (vectors.has(key)) counter.hits++
    else {
      counter.misses++
      if (!missing.has(key)) missing.set(key, input)
    }
  }
  if (missing.size > 0) {
    const started = performance.now()
    try {
      const fresh = await embedTexts(
        [...missing.values()],
        textEmbeddingConfig,
        () => {
          counter.requests++
        },
      )
      ;[...missing.keys()].forEach((key, index) => {
        const vector = fresh[index]
        if (vector) vectors.set(key, vector)
      })
    } finally {
      counter.seconds += (performance.now() - started) / 1000
    }
  }
  let next = 0
  return documents.map((rows) => ({
    ...rows,
    chunks: rows.chunks.map((chunk) => {
      if (!chunk.text.trim()) return { ...chunk, embedding: [] }
      const key = keys[next++] ?? ""
      const vector = vectors.get(key)
      if (!vector) throw new Error("A chunk got no vector")
      return { ...chunk, embedding: vector, embeddingKey: key }
    }),
  }))
}

/** The introducing commit of each knowledge file (`fileIntroductions`). */
type FileIntroductions = {
  /** The time of the commit that introduced each path. */
  introducedAtByPath: Map<string, string>
  /**
   * The paths that a commit added on one side only of the fork between the
   * tip and an earlier SHA.
   */
  addedSinceFork: string[]
}

/**
 * The commit that introduced each knowledge file at `tip`, with the rule of
 * the old stack (`readMarkdownHistory`): the newest commit that added the
 * path. One fetch with no blobs and one walk of the history, for all files,
 * so the cost does not grow with each file. Paths are relative to `root`.
 *
 * In a delta, a file can get a different introducing commit with no change
 * in the diff from an earlier SHA (`last_sha` or a SHA of a failed run): a
 * commit removed the file and a later commit added it again, a merge
 * brought an earlier add, or the tip went back to an older commit. Then the
 * introducing commit at the tip or at the earlier SHA is on one side only of
 * their fork. `addedSinceFork` gives each path that such a commit added, so
 * the delta writes the `valid_from` of a full rebuild. The walk of each
 * fork reads only the commits after it.
 */
async function fileIntroductions(input: {
  directory: string
  remote: KnowledgeRemote
  root: string
  tip: string
  /** The `last_sha` and the `attempt_shas` of a delta; empty for a full rebuild. */
  earlier: readonly string[]
}): Promise<FileIntroductions> {
  const { directory, root, tip } = input
  await fetchGitHistory(directory, {
    url: input.remote.url,
    sha: tip,
    token: await input.remote.token(),
  })
  const { introduced } = await readMarkdownHistory(directory, {
    sha: tip,
    root,
  })
  const introducedAtByPath = new Map<string, string>()
  for (const [repositoryPath, timestamp] of introduced) {
    const path = workspaceRelativePath(root, repositoryPath)
    if (path !== null) introducedAtByPath.set(path, timestamp)
  }
  const added = new Set<string>()
  for (const sha of new Set(input.earlier))
    if (sha !== tip)
      for (const repositoryPath of (
        await nativeGit(directory, [
          "--no-lazy-fetch",
          "log",
          "--format=",
          "--name-only",
          "-z",
          "--diff-filter=A",
          "--no-renames",
          `${tip}...${sha}`,
          "--",
          "*.md",
        ])
      )
        .toString()
        .split("\0")) {
        // An empty format puts a newline before the paths of each commit.
        const name = repositoryPath.replace(/^\n/, "")
        const path = name ? workspaceRelativePath(root, name) : null
        if (path !== null) added.add(path)
      }
  return { introducedAtByPath, addedSinceFork: [...added] }
}

/**
 * Fetch the tip, then the commits of earlier runs. A commit that the remote
 * does not have any more (a force-push and a Git GC) stays out, so the
 * planner sees it as missing and rebuilds in full.
 */
async function fetchCommits(
  directory: string,
  remote: KnowledgeRemote,
  tip: string,
  earlier: string[],
): Promise<void> {
  const token = await remote.token()
  const fetch = (shas: string[]) =>
    fetchGitCommits(directory, { url: remote.url, shas, token })
  await fetch([tip])
  const rest = [...new Set(earlier)].filter((sha) => sha !== tip)
  if (rest.length === 0) return
  try {
    await fetch(rest)
  } catch {
    for (const sha of rest)
      await fetch([sha]).catch((error: unknown) => {
        // Only a commit that the remote does not have: any other error is
        // an infrastructure error, and the run retries.
        if (!/not our ref/i.test(String(error))) throw error
        getLogger().warn(
          "A commit of the knowledge state is not on the remote",
          { step: "knowledge-plane.fetch", sha },
        )
      })
  }
}

/** Each regular file of the root folder at `sha` → its blob id. */
export async function regularFiles(
  directory: string,
  sha: string,
  root: string,
): Promise<Map<string, string>> {
  const output = await nativeGit(directory, [
    "ls-tree",
    "-r",
    "-z",
    sha,
    ...(root ? ["--", `${root}/`] : []),
  ])
  return new Map(
    output
      .toString()
      .split("\0")
      .flatMap((entry) => {
        const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(entry)
        const path = match?.[3] ? workspaceRelativePath(root, match[3]) : null
        return match?.[2] && path ? [[path, match[2]] as const] : []
      }),
  )
}

/**
 * The span attributes, the metrics and the log fields of one run (ADR-067
 * decision 11). The metrics have no Workspace attribute; the wide event of
 * the hydrate run has the Workspace, for the lag alert of each Workspace.
 */
function recordRun(input: {
  span: Span
  seconds: number
  summary: KnowledgeRunSummary | undefined
  /** The mutations of the run, also of a failed run. */
  mutations: number
  /** The embedding work of the run, also of a failed run. */
  embedding: EmbeddingCounter
  /** The file conversions and image texts of the run, also of a failed run. */
  files: FileCounter
}): void {
  const { summary } = input
  const outcome = summary ? "completed" : "failed"
  const mode = summary?.mode ?? "unknown"
  const meter = metrics.getMeter("ctxpipe-backend")
  meter
    .createHistogram("knowledge.projection.duration", {
      description: "The time of one knowledge projection run",
      unit: "s",
    })
    .record(input.seconds, { outcome, mode })
  meter
    .createHistogram("knowledge.projection.mutations", {
      description: "The ClickHouse mutations of one knowledge projection run",
      unit: "{mutation}",
    })
    .record(input.mutations, { outcome, mode })
  // The hits divided by all lookups is the hit rate of the vector reuse
  // (ADR-067 decision 5).
  const { embedding } = input
  const lookups = meter.createHistogram(
    "knowledge.projection.embedding_lookups",
    {
      description:
        "The lookups of a stored vector of one knowledge projection run, by result",
      unit: "{input}",
    },
  )
  lookups.record(embedding.hits, { outcome, mode, result: "hit" })
  lookups.record(embedding.misses, { outcome, mode, result: "miss" })
  meter
    .createHistogram("knowledge.projection.embedding_requests", {
      description: "The embedding requests of one knowledge projection run",
      unit: "{request}",
    })
    .record(embedding.requests, { outcome, mode })
  meter
    .createHistogram("knowledge.projection.embedding_duration", {
      description:
        "The time in the embedding API of one knowledge projection run",
      unit: "s",
    })
    .record(embedding.seconds, { outcome, mode })
  // The file conversions by format and result, and the image texts
  // (CTX-1433): the cache hit rate, the failures and the vision cost.
  const conversions = meter.createCounter("knowledge.projection.conversions", {
    description:
      "The file conversions of the knowledge projection, by format and result",
    unit: "{file}",
  })
  for (const [format, results] of input.files.conversions)
    for (const [result, count] of results)
      conversions.add(count, { outcome, mode, format, result })
  const { images } = input.files
  const imageTextHistogram = meter.createHistogram(
    "knowledge.projection.image_texts",
    {
      description:
        "The images of one knowledge projection run, by result: a cache hit, a vision call, or a failure",
      unit: "{image}",
    },
  )
  imageTextHistogram.record(images.hits, { outcome, mode, result: "hit" })
  imageTextHistogram.record(images.misses, { outcome, mode, result: "miss" })
  imageTextHistogram.record(images.failures, {
    outcome,
    mode,
    result: "failure",
  })
  meter
    .createHistogram("knowledge.projection.vision_cost", {
      description:
        "The cost of the vision calls of one knowledge projection run",
      unit: "USD",
    })
    .record(images.costUsd, { outcome, mode })
  const fields: Record<string, string | number> = {
    "ctxpipe.knowledge.image_hits": images.hits,
    "ctxpipe.knowledge.image_misses": images.misses,
    "ctxpipe.knowledge.image_failures": images.failures,
    "ctxpipe.knowledge.vision_cost_usd": images.costUsd,
    "ctxpipe.knowledge.outcome": outcome,
    "ctxpipe.knowledge.mode": mode,
    "ctxpipe.knowledge.duration_s": input.seconds,
    "ctxpipe.knowledge.mutations": input.mutations,
    "ctxpipe.knowledge.embedding_hits": embedding.hits,
    "ctxpipe.knowledge.embedding_misses": embedding.misses,
    "ctxpipe.knowledge.embedding_requests": embedding.requests,
    "ctxpipe.knowledge.embedding_s": embedding.seconds,
  }
  if (summary?.mode === "delta" || summary?.mode === "full") {
    meter
      .createCounter("knowledge.projection.documents_changed", {
        description: "Documents that a knowledge projection run changed",
        unit: "{document}",
      })
      .add(summary.documentsChanged, { mode })
    meter
      .createHistogram("knowledge.projection.failed_documents", {
        description: "The failed documents of a Workspace after a run",
        unit: "{document}",
      })
      .record(summary.failedCount)
    Object.assign(fields, {
      "ctxpipe.knowledge.full_reason": summary.fullReason ?? "",
      "ctxpipe.knowledge.documents_changed": summary.documentsChanged,
      "ctxpipe.knowledge.failed_count": summary.failedCount,
    })
  }
  input.span.setAttributes(fields)
  getLogger().set({
    knowledgeProjection: {
      outcome,
      mode,
      seconds: input.seconds,
      mutations: input.mutations,
      embedding,
      conversions: Object.fromEntries(
        [...input.files.conversions].map(([format, results]) => [
          format,
          Object.fromEntries(results),
        ]),
      ),
      images,
      ...summary,
    },
  })
}
