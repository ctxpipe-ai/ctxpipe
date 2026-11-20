import { metrics, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

import { githubSourceRepositories } from "../domain/workspace-sources/github-sources.js"
import {
  isSourcesTreePath,
  SOURCES_FOLDER_PREFIX,
} from "../domain/workspace-sources/source-tree.js"
import { SOURCES_FILE_PATH } from "../domain/workspace-sources/sources-file.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import {
  imageContentType,
  imageOfBytes,
} from "../domain/workspaces/raw-file.js"
import {
  type DocumentRows,
  type DocumentStatus,
  type KnowledgeScope,
  type KnowledgeStore,
  type MutationCounter,
  REFERENCE_TARGET_PREFIX,
} from "../knowledge-store/knowledge-store.js"
import { mapWithConcurrency } from "../lib/mapWithConcurrency.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
  failKnowledgeRun,
  getKnowledgeState,
} from "../models/knowledge-state.js"
import { getLogger } from "../observability/logger.js"
import {
  EmbeddingStatusError,
  type EmbeddingInput,
  embeddingKey,
  embedMultimodal,
  multimodalEmbeddingConfig,
} from "../retrieval/embeddings/multimodalEmbeddings.js"
import {
  fetchGitHistory,
  readMarkdownHistory,
} from "../services/git/clone-tree.js"
import {
  fetchGitCommits,
  nativeGit,
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
  isKnowledgePath,
  parseKnowledgeFile,
  workspaceBlobPath,
} from "./parse-file.js"
import {
  imageRows,
  knowledgeRows,
  type UnembeddedDocumentRows,
} from "./rows.js"

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
 * vectors of its document (`embedWithReuse`): an input whose key
 * (`embeddingKey`) has a stored vector gets that vector, and only the other
 * inputs go to the model. Thus a full rebuild embeds only new content.
 *
 * The vector of an image comes from its bytes at the tip. An image that the
 * embedding model does not take (its type or its size) gets a `failed`
 * document, and the run goes on (ADR-066 decision 6). The bytes stay in
 * the Workspace Git: the writer stores no copy.
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
    embeddingModel: multimodalEmbeddingConfig.model,
    dimensions: multimodalEmbeddingConfig.dimensions,
    root: input.root,
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
        reused: 0,
        embedded: 0,
        requests: 0,
        seconds: 0,
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
}): Promise<number> {
  const { workspaceId, root, store, observedAt, directory, plan } = input
  const scope: KnowledgeScope = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
  }
  const keyOf = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const isDocumentPath = (path: string) =>
    isKnowledgePath(path) || imageContentType(path) !== null
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
    const documents: DocumentRows[] = []
    const failed: { docKey: string; error: string }[] = []
    await inBatches(group, 50, async (batch) => {
      const rows = await projectFiles({
        reuse: { store, scope, counter: input.embedding },
        directory,
        keyOf,
        workspaceId,
        blobPath,
        sourceRepositories,
        observedAt,
        introducedAtByPath: input.introductions.introducedAtByPath,
        paths: batch,
        blobs: batch.map((path) => tree.get(path) ?? ""),
      })
      documents.push(...rows.documents)
      failed.push(...rows.failed)
    })
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

/**
 * The rows of each file of `paths`: a document, or a `failed` placeholder
 * with the content error. A knowledge file that gives no unit gives no row.
 */
async function projectFiles(input: {
  reuse: VectorReuse
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
}): Promise<{
  documents: DocumentRows[]
  failed: { docKey: string; error: string }[]
}> {
  const { workspaceId, keyOf, blobPath, observedAt } = input
  const contents = await readGitBlobs(input.directory, input.blobs)
  const documents: UnembeddedDocumentRows[] = []
  const images: {
    rows: UnembeddedDocumentRows
    bytes: Buffer
    mimeType: string
  }[] = []
  const failed: { docKey: string; error: string }[] = []
  for (const [index, path] of input.paths.entries()) {
    const bytes = contents[index] ?? Buffer.alloc(0)
    if (!isKnowledgePath(path)) {
      const image = embeddableImage(path, bytes)
      if ("error" in image)
        failed.push({ docKey: keyOf(path), error: image.error })
      else
        images.push({
          rows: imageRows({ workspaceId, path, observedAt }),
          bytes,
          mimeType: image.mimeType,
        })
      continue
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
      if (parsed.kind === "failed")
        failed.push({ docKey: keyOf(path), error: parsed.error })
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
      failed.push({
        docKey: keyOf(path),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const embeddedImages = await embedImages(images, input.reuse)
  return {
    documents: [
      ...(await embedDocuments(documents, input.reuse)),
      ...embeddedImages.documents,
    ],
    failed: [...failed, ...embeddedImages.failed],
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
  /** The inputs (chunks and images) that got a stored vector. */
  reused: number
  /** The inputs with no stored vector. */
  embedded: number
  /**
   * The inputs that went to the model. Inputs of one batch with the same key
   * go one time. A retry of a request is not counted again.
   */
  requests: number
  /** The time in the embedding API, in seconds. */
  seconds: number
}

/** The store that holds the earlier vectors, and the counter of the run. */
type VectorReuse = {
  store: KnowledgeStore
  scope: KnowledgeScope
  counter: EmbeddingCounter
}

/**
 * The vector of each input of `inputs`, in order, and its key: the stored
 * vector of the key in a document of `docKeys`, else the result of `embed`.
 * `embed` gets the inputs with no stored vector, one for each key, and gives
 * a result for each, in order. Inputs with the same key share that result.
 *
 * The lookup reads only the chunks of `docKeys` in the Workspace of the run
 * (ADR-067 decision 5). They are the rows that this write replaces, before
 * its DELETE, and the rows that an earlier write of the same file gave. A
 * stored vector is the BFloat16 value, so its write stores the same value
 * as a write of the new vector.
 */
async function embedWithReuse<R>(
  reuse: VectorReuse,
  docKeys: string[],
  inputs: EmbeddingInput[],
  embed: (inputs: EmbeddingInput[]) => Promise<R[]>,
): Promise<{ key: string; vector: number[] | R }[]> {
  const { counter } = reuse
  const keys = inputs.map((input) => embeddingKey(input))
  const stored =
    inputs.length === 0
      ? new Map<string, number[]>()
      : await reuse.store.readEmbeddings(reuse.scope, docKeys, keys)
  const missing = new Map<string, EmbeddingInput>()
  for (const [index, input] of inputs.entries()) {
    const key = keys[index] ?? ""
    if (stored.has(key)) counter.reused++
    else {
      counter.embedded++
      if (!missing.has(key)) missing.set(key, input)
    }
  }
  const fresh = new Map<string, R>()
  if (missing.size > 0) {
    counter.requests += missing.size
    const started = performance.now()
    try {
      const missingKeys = [...missing.keys()]
      for (const [index, result] of (
        await embed([...missing.values()])
      ).entries()) {
        const key = missingKeys[index]
        if (key !== undefined) fresh.set(key, result)
      }
    } finally {
      counter.seconds += (performance.now() - started) / 1000
    }
  }
  return keys.map((key) => {
    const vector = stored.get(key) ?? fresh.get(key)
    if (vector === undefined) throw new Error("An input got no vector")
    return { key, vector }
  })
}

/** Embed the text chunks of each document. A chunk with no text gets no vector. */
async function embedDocuments(
  documents: UnembeddedDocumentRows[],
  reuse: VectorReuse,
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
  const vectors = await embedWithReuse(
    reuse,
    documents.map(({ document }) => document.docKey),
    inputs,
    embedMultimodal,
  )
  let next = 0
  return documents.map((rows) => ({
    ...rows,
    chunks: rows.chunks.map((chunk) => {
      if (!chunk.text.trim()) return { ...chunk, embedding: [] }
      const { key, vector } = vectors[next++] ?? { key: "", vector: [] }
      return { ...chunk, embedding: vector, embeddingKey: key }
    }),
  }))
}

/**
 * The type of the image file at `path`, from its bytes, when the embedding
 * model takes it; else the error for the `failed` document of the file. The
 * type comes from the bytes, so a file with a wrong name (or bytes that are
 * not an image) does not go to the model and fail the run.
 */
function embeddableImage(
  path: string,
  bytes: Buffer,
): { mimeType: string } | { error: string } {
  const { imageTypes, maxImageBytes } = multimodalEmbeddingConfig
  const image = imageOfBytes(bytes)
  // The type of the bytes, else the type of the file name.
  const type = image?.contentType ?? imageContentType(path) ?? "unknown"
  if (!imageTypes.includes(type))
    return {
      error: `The embedding model does not take images of type ${type}.`,
    }
  if (!image) return { error: `The bytes are not an image of type ${type}.` }
  if (bytes.length > maxImageBytes)
    return {
      error: `The image has ${bytes.length} bytes. The embedding model takes at most ${maxImageBytes}.`,
    }
  return { mimeType: image.contentType }
}

/**
 * Embed the bytes of each image, one image for each request. The vector goes
 * on the one chunk of the image, whose text is empty, so the request has the
 * image part only (ADR-066 decision 6). An image whose bytes have a stored
 * vector gets that vector (`embedWithReuse`). At most
 * `multimodalEmbeddingConfig.concurrency` requests are in flight.
 *
 * The model can refuse the bytes of an image with a good header (for
 * example a cut file). An image that it refuses (HTTP 400, 413 or 422) gets
 * a `failed` document. Another error fails the run.
 */
async function embedImages(
  images: { rows: UnembeddedDocumentRows; bytes: Buffer; mimeType: string }[],
  reuse: VectorReuse,
): Promise<{
  documents: DocumentRows[]
  failed: { docKey: string; error: string }[]
}> {
  /** The vector of one image, or the status of a refusal of its content. */
  const embedAlone = async (
    input: EmbeddingInput,
  ): Promise<number[] | { refused: number }> => {
    try {
      return (await embedMultimodal([input]))[0] ?? []
    } catch (error) {
      if (
        !(error instanceof EmbeddingStatusError) ||
        ![400, 413, 422].includes(error.status)
      )
        throw error
      return { refused: error.status }
    }
  }
  const vectors = await embedWithReuse(
    reuse,
    images.map((image) => image.rows.document.docKey),
    images.map(({ bytes, mimeType }) => ({
      kind: "image" as const,
      bytes,
      mimeType,
    })),
    (missing) =>
      mapWithConcurrency(
        missing,
        multimodalEmbeddingConfig.concurrency,
        embedAlone,
      ),
  )
  const documents: DocumentRows[] = []
  const failed: { docKey: string; error: string }[] = []
  for (const [index, image] of images.entries()) {
    const { key, vector } = vectors[index] ?? { key: "", vector: [] }
    if ("refused" in vector)
      failed.push({
        docKey: image.rows.document.docKey,
        error: `The embedding model refused the image (HTTP ${vector.refused}).`,
      })
    else
      documents.push({
        ...image.rows,
        chunks: image.rows.chunks.map((chunk) => ({
          ...chunk,
          embedding: vector,
          embeddingKey: key,
        })),
      })
  }
  return { documents, failed }
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
  // The share of the inputs that got a stored vector is the hit rate of the
  // vector reuse (ADR-067 decision 5).
  const { embedding } = input
  const inputs = meter.createHistogram("knowledge.projection.embedding_inputs", {
    description:
      "The embedding inputs of one knowledge projection run, by the source of the vector",
    unit: "{input}",
  })
  inputs.record(embedding.reused, { outcome, mode, source: "stored" })
  inputs.record(embedding.embedded, { outcome, mode, source: "model" })
  meter
    .createHistogram("knowledge.projection.embedding_requests", {
      description: "The embedding requests of one knowledge projection run",
      unit: "{request}",
    })
    .record(embedding.requests, { outcome, mode })
  meter
    .createHistogram("knowledge.projection.embedding_duration", {
      description: "The time in the embedding API of one knowledge projection run",
      unit: "s",
    })
    .record(embedding.seconds, { outcome, mode })
  const fields: Record<string, string | number> = {
    "ctxpipe.knowledge.outcome": outcome,
    "ctxpipe.knowledge.mode": mode,
    "ctxpipe.knowledge.duration_s": input.seconds,
    "ctxpipe.knowledge.mutations": input.mutations,
    "ctxpipe.knowledge.embedding_reused": embedding.reused,
    "ctxpipe.knowledge.embedding_embedded": embedding.embedded,
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
      ...summary,
    },
  })
}
