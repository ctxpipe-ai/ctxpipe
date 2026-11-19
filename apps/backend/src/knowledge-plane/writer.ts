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
      /** Seconds from the commit of `last_sha` to that of the tip, at the start. */
      let lagSeconds: number | null = null
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
            lagSeconds = state?.lastSha
              ? await commitLag(directory, state.lastSha, input.tip)
              : null
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
                lastSha: plan.kind === "delta" ? (state?.lastSha ?? null) : null,
              }),
              counter,
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
          lagSeconds,
          mutations: counter.mutations,
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
  // document. A delta also writes each file that a new commit introduced,
  // because its `valid_from` changes when the diff does not show it.
  const files = [
    ...new Set(
      plan.kind === "full"
        ? plan.files
        : [...plan.changed, ...input.introductions.newlyIntroduced],
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
        directory,
        keyOf,
        workspaceId,
        blobPath,
        sourceRepositories,
        observedAt,
        introducedAt: input.introductions.introducedAt,
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
  directory: string
  /** The document key of a path. */
  keyOf: (path: string) => string
  workspaceId: string
  blobPath: ReturnType<typeof workspaceBlobPath>
  sourceRepositories: Map<string, string>
  observedAt: Date
  /** The time of the introducing commit of each path. */
  introducedAt: ReadonlyMap<string, string>
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
            introducedAt: input.introducedAt.get(path) ?? null,
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
  const embeddedImages = await embedImages(images)
  return {
    documents: [
      ...(await embedDocuments(documents)),
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

/** Embed the text chunks of each document. A chunk with no text gets no vector. */
async function embedDocuments(
  documents: UnembeddedDocumentRows[],
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
  const vectors = await embedMultimodal(inputs)
  let next = 0
  return documents.map((rows) => ({
    ...rows,
    chunks: rows.chunks.map((chunk) => ({
      ...chunk,
      embedding: chunk.text.trim() ? (vectors[next++] ?? []) : [],
    })),
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
 * Embed the bytes of each image. The vector goes on the one chunk of the
 * image, whose text is empty, so the request has the image part only
 * (ADR-066 decision 6). Images share a request until their bytes reach
 * `maxImageBytes`, so that one request stays in the provider limit.
 *
 * The model can refuse the bytes of an image with a good header (for
 * example a cut file). When it refuses a request (HTTP 400, 413 or 422),
 * each image of the request goes again alone, and an image that it refuses
 * alone gets a `failed` document. Another error fails the run.
 */
async function embedImages(
  images: { rows: UnembeddedDocumentRows; bytes: Buffer; mimeType: string }[],
): Promise<{
  documents: DocumentRows[]
  failed: { docKey: string; error: string }[]
}> {
  const requests: (typeof images)[] = []
  let size = 0
  for (const image of images) {
    const last = requests.at(-1)
    if (
      last &&
      size + image.bytes.length <= multimodalEmbeddingConfig.maxImageBytes
    ) {
      last.push(image)
      size += image.bytes.length
    } else {
      requests.push([image])
      size = image.bytes.length
    }
  }
  const embed = (request: typeof images) =>
    embedMultimodal(
      request.map(({ bytes, mimeType }) => ({
        kind: "image" as const,
        bytes,
        mimeType,
      })),
    )
  /** The status of a refusal of the content, else null. */
  const refused = (error: unknown) =>
    error instanceof EmbeddingStatusError &&
    [400, 413, 422].includes(error.status)
      ? error.status
      : null
  const documents: DocumentRows[] = []
  const failed: { docKey: string; error: string }[] = []
  const add = (image: (typeof images)[number], vector: number[]) =>
    documents.push({
      ...image.rows,
      chunks: image.rows.chunks.map((chunk) => ({
        ...chunk,
        embedding: vector,
      })),
    })
  for (const request of requests) {
    try {
      const vectors = await embed(request)
      request.forEach((image, index) => add(image, vectors[index] ?? []))
    } catch (error) {
      if (refused(error) === null) throw error
      for (const image of request) {
        try {
          add(image, (await embed([image]))[0] ?? [])
        } catch (alone) {
          const status = refused(alone)
          if (status === null) throw alone
          failed.push({
            docKey: image.rows.document.docKey,
            error: `The embedding model refused the image (HTTP ${status}).`,
          })
        }
      }
    }
  }
  return { documents, failed }
}

/** The introducing commit of each knowledge file (`fileIntroductions`). */
type FileIntroductions = {
  /** The time of the commit that introduced each path. */
  introducedAt: Map<string, string>
  /** The paths whose introducing commit is not in the history of `last_sha`. */
  newlyIntroduced: string[]
}

/**
 * The commit that introduced each knowledge file at `tip`, with the rule of
 * the old stack (`readMarkdownHistory`): the newest commit that added the
 * path. One fetch with no blobs and one walk of the history, for all files,
 * so the cost does not grow with each file. Paths are relative to `root`.
 *
 * In a delta, a file can get a new introducing commit with no change in the
 * diff from `lastSha`: a commit removed it and a later commit added it
 * again, or a merge brought an earlier add. `newlyIntroduced` gives such
 * files, so the delta writes the `valid_from` of a full rebuild.
 */
async function fileIntroductions(input: {
  directory: string
  remote: KnowledgeRemote
  root: string
  tip: string
  /** `last_sha` of a delta, else null. */
  lastSha: string | null
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
  const newCommits = new Set(
    input.lastSha
      ? (await nativeGit(directory, ["rev-list", tip, "--not", input.lastSha]))
          .toString()
          .split("\n")
          .filter(Boolean)
      : [],
  )
  const introducedAt = new Map<string, string>()
  const newlyIntroduced: string[] = []
  for (const [repositoryPath, { timestamp, commit }] of introduced) {
    const path = workspaceRelativePath(root, repositoryPath)
    if (path === null) continue
    introducedAt.set(path, timestamp)
    if (newCommits.has(commit)) newlyIntroduced.push(path)
  }
  return { introducedAt, newlyIntroduced }
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

/** Seconds from the commit time of `from` to that of `to`, or null. */
async function commitLag(
  directory: string,
  from: string,
  to: string,
): Promise<number | null> {
  const time = async (sha: string) =>
    Number(
      (await nativeGit(directory, ["show", "-s", "--format=%ct", sha]))
        .toString()
        .trim(),
    )
  try {
    return Math.max(0, (await time(to)) - (await time(from)))
  } catch {
    // The commit of `from` is missing.
    return null
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
  lagSeconds: number | null
  /** The mutations of the run, also of a failed run. */
  mutations: number
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
  const fields: Record<string, string | number> = {
    "ctxpipe.knowledge.outcome": outcome,
    "ctxpipe.knowledge.mode": mode,
    "ctxpipe.knowledge.duration_s": input.seconds,
    "ctxpipe.knowledge.mutations": input.mutations,
  }
  if (input.lagSeconds !== null) {
    meter
      .createHistogram("knowledge.projection.lag", {
        description: "From the commit of last_sha to the tip, at run start",
        unit: "s",
      })
      .record(input.lagSeconds, { outcome })
    fields["ctxpipe.knowledge.lag_s"] = input.lagSeconds
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
      lagSeconds: input.lagSeconds,
      mutations: input.mutations,
      ...summary,
    },
  })
}
