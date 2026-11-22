import { createHash } from "node:crypto"

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
  type FileDocument,
  type FileVersionKey,
  fileVersionId,
  type FileVersionRows,
  type KnowledgeScope,
  type KnowledgeStore,
  type MutationCounter,
  type TreeEntry,
  type TreeHead,
} from "../knowledge-store/knowledge-store.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
  failKnowledgeRun,
  getBranchHead,
  markBranchWaiting,
  readyKnowledgeHeads,
  treeHeadOf,
} from "../models/knowledge-state.js"
import { getLogger } from "../observability/logger.js"
import {
  type EmbeddingInput,
  embeddingKey,
  embedTexts,
  textEmbeddingConfig,
} from "../retrieval/embeddings/textEmbeddings.js"
import { scrubForModel } from "../retrieval/services/scrubForModel.js"
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
  type KnowledgeRebuildReason,
  knowledgeProjectionVersion,
  mergeBaseOf,
  planKnowledgeChangeSet,
  planOverlay,
} from "./change-set.js"
import {
  convertFile,
  converterVersion,
  type FileType,
  fileType,
} from "./convert-file.js"
import {
  type ImageTextCounter,
  imageTextModel,
  imageTexts,
} from "./image-text.js"
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
  /** The head is the tip, with the current projection version. */
  | { mode: "current" }
  /**
   * A branch that is not the default branch, while the default branch has
   * no head to be its base: the first run of the default branch queues a
   * run of this branch again.
   */
  | { mode: "waiting" }
  | {
      mode: KnowledgeChangeSet["kind"]
      fullReason: KnowledgeFullReason | null
      /** The tree rows that the run wrote: changed paths and tombstones. */
      documentsChanged: number
      /** The `failed` documents of the tree of the branch after the run. */
      failedCount: number
    }

/**
 * The projection writer of the knowledge plane (ADR-067, ADR-071). It moves
 * the tree of one branch of one Workspace from `last_sha` to `tip`. The
 * default branch has a full tree; each other branch has an overlay on the
 * tree of the default branch (ADR-071 decision 3):
 * 1. A run after a stopped run deletes the tree rows above the head.
 * 2. The planner gives the change set: a delta or a full rebuild for the
 *    default branch, the overlay (the diff from the merge base) for another
 *    branch.
 * 3. Each changed document file gets its file version: the stored one with
 *    the same key (`fileVersion`), else a new one from its file. A knowledge
 *    file (Markdown) that does not parse, or a file that does not convert,
 *    gets a `failed` file version.
 * 4. Each path whose file version or `valid_from` changed gets a tree row
 *    with the next tree version. The `valid_from` of a document is the
 *    source time of its file version (CTX-1516), else, for a knowledge
 *    file, the time of the commit that introduced it, from one walk of the
 *    Git history of the tip (`fileIntroductions`).
 * 5. Each path whose file is gone gets a tombstone row. A full rebuild does
 *    this for each path of the head that the tree does not give. An overlay
 *    gets an `inherit` row for each path that left it.
 * 6. `completeKnowledgeRun` moves the head to the tip and the tree version.
 *    No read sees the rows of the run before this.
 *
 * An infrastructure error (Git, ClickHouse, Postgres, the embedding API)
 * throws, and `failKnowledgeRun` records it. The caller holds the knowledge
 * projection lease of the Workspace, so one run of a Workspace runs at a
 * time, for all its branches (ADR-071 decision 7).
 *
 * Before a file goes to the embedding model, the writer reads the stored
 * vectors of its document (`embedDocuments`): an input whose key
 * (`embeddingKey`) has a stored vector gets that vector, and only the other
 * inputs go to the model. The writer reads no image bytes at retrieval, and
 * it stores no copy of them.
 */
export async function projectKnowledgePlane(input: {
  orgId: string
  workspaceId: string
  remote: KnowledgeRemote
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  branch: string
  tip: string
  /**
   * The tip of the default branch in Git, for a branch that is not the
   * default branch (the merge base of its overlay). Null for a run of the
   * default branch.
   */
  defaultTip: string | null
  /** A store with the writer user. */
  store: KnowledgeStore
  observedAt: Date
  /**
   * Rebuild the tree of the default branch in full, also when the head is
   * the tip (`rebuildKnowledgePlane`, ADR-067 decision 8). Not for another
   * branch.
   */
  rebuild?: boolean
}): Promise<KnowledgeRunSummary> {
  const key = { orgId: input.orgId, workspaceId: input.workspaceId }
  const branchKey = { ...key, branch: input.branch }
  const isDefault = input.defaultTip === null
  const projectionVersion = knowledgeProjectionVersion({
    embeddingModel: textEmbeddingConfig.model,
    dimensions: textEmbeddingConfig.dimensions,
    root: input.root,
    converter: await converterVersion(),
    visionModel: imageTextModel(),
  })
  // The base of an overlay: the head of the default branch. During a rename
  // of the default branch, that can be this branch. Then the branch waits
  // for the first completed run of the default branch, which queues it again.
  const base = isDefault
    ? null
    : ((await readyKnowledgeHeads(input.orgId, [input.workspaceId])).get(
        input.workspaceId,
      ) ?? null)
  if (!isDefault && (!base || base.branch === input.branch)) {
    await markBranchWaiting(branchKey)
    return { mode: "waiting" }
  }
  const state = await getBranchHead(branchKey)
  // The default branch always has a tree row when its tip has a document
  // file. A head with no row lost its rows, for example to a fault of
  // ClickHouse: `current` or a delta cannot repair that, so the run
  // rebuilds in full from Git (ADR-067 decision 8). One read on each run.
  const defaultHead = isDefault ? treeHeadOf(state) : null
  const rebuildReason = async (): Promise<KnowledgeRebuildReason | null> => {
    if (!isDefault) return null
    if (input.rebuild) return "rebuild"
    if (defaultHead && !(await input.store.hasTree(key, defaultHead)))
      return "empty_tree"
    return null
  }
  const current =
    state?.lastSha === input.tip &&
    state.runStatus === "completed" &&
    state.projectionVersion === projectionVersion &&
    // The tree is of the right kind: a full tree for the default branch, an
    // overlay on the current default branch for each other branch.
    state.baseBranch === (base?.branch ?? null)
  // A run of the tip reads it here. Each other run reads it after
  // `beginKnowledgeRun`, so that an error of ClickHouse fails the run.
  const earlyReason = current ? await rebuildReason() : undefined
  if (current && !earlyReason) return { mode: "current" }

  const started = performance.now()
  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan("knowledge.projection.apply", async (span) => {
      span.setAttributes({
        "ctxpipe.org.id": input.orgId,
        "ctxpipe.workspace.id": input.workspaceId,
        "ctxpipe.knowledge.default_branch": isDefault,
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
        await beginKnowledgeRun({ ...branchKey, isDefault })
        const forcedReason = earlyReason ?? (await rebuildReason())
        // The head of the branch, or none before its first run. The tree
        // rows above the head are the rows of a run that stopped: no read
        // sees them, and this run must not show them either (ADR-071
        // decision 4). A run with no head starts from no rows, so that its
        // tree versions never mix with older rows of the branch.
        const head = treeHeadOf(state)
        if (!head || state?.runStatus !== "completed")
          await input.store.deleteTreeAbove(
            key,
            input.branch,
            head?.treeVersion ?? 0,
            counter,
          )
        const treeVersion = (head?.treeVersion ?? 0) + 1
        summary = await withGitDirectory(
          input.tip,
          async (directory) => {
            const lastSha = state?.lastSha ?? null
            await fetchCommits(
              directory,
              input.remote,
              input.tip,
              input.defaultTip ?? lastSha,
            )
            // The history of both tips in one fetch, so that `git
            // merge-base` can walk them. `fileIntroductions` then finds the
            // history of the tip already there.
            let mergeBase: string | null = null
            if (input.defaultTip) {
              await fetchGitHistory(directory, {
                url: input.remote.url,
                sha: [input.tip, input.defaultTip],
                token: await input.remote.token(),
              })
              mergeBase = await mergeBaseOf(
                directory,
                input.tip,
                input.defaultTip,
              )
            }
            const plan = mergeBase
              ? await planOverlay({
                  directory,
                  root: input.root,
                  mergeBase,
                  tip: input.tip,
                })
              : await planKnowledgeChangeSet({
                  directory,
                  root: input.root,
                  state,
                  tip: input.tip,
                  projectionVersion,
                  rebuild: forcedReason,
                })
            const applied = await applyChangeSet({
              ...input,
              directory,
              plan,
              projectionVersion,
              head,
              base,
              treeVersion,
              // A rebuild writes new file versions: a stored one can have
              // lost rows that its document row does not show.
              rebuildId: forcedReason ? input.observedAt.toISOString() : null,
              introductions: await fileIntroductions({
                directory,
                remote: input.remote,
                root: input.root,
                tip: input.tip,
                base: plan.kind === "delta" ? lastSha : null,
              }),
              counter,
              embedding,
              files,
            })
            await completeKnowledgeRun({
              ...branchKey,
              tip: input.tip,
              treeVersion,
              baseBranch: base?.branch ?? null,
              projectionVersion,
              failedCount: applied.failedCount,
            })
            return {
              mode: plan.kind,
              fullReason: plan.kind === "full" ? plan.reason : null,
              documentsChanged: applied.changed,
              failedCount: applied.failedCount,
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
          await failKnowledgeRun({ ...branchKey, isDefault })
        } catch (stateError) {
          // The run error is the cause. The next run starts from the same
          // head either way.
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
 * The version of a file (ADR-071 decision 2): the SHA-256 (32 hex
 * characters) of its blob SHA and its variant.
 */
const fileVersion = (blobSha: string, variant: string) =>
  createHash("sha256")
    .update(`${blobSha}\0${variant}`)
    .digest("hex")
    .slice(0, 32)

/**
 * The variant of a file (ADR-071 decision 2): a hash of the inputs of its
 * rows that are not in the file. These are the projection version, and for
 * a knowledge file:
 * - the URL of the Workspace repository, because a blob URL of it in a link
 *   resolves to a Workspace path (`workspaceBlobPath`);
 * - the source repositories of the tree, because the `CHANGED` keys of a
 *   package file come from them.
 *
 * A full rebuild after lost rows also adds its `rebuildId` (ADR-067 decision
 * 8), so that it writes each file version again. Without it, the variant is
 * the same as before.
 */
const fileVariant = (
  projectionVersion: string,
  knowledge: {
    remoteUrl: string
    sourceRepositories: ReadonlyMap<string, string>
  } | null,
  rebuildId: string | null,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        projectionVersion,
        knowledge && [
          knowledge.remoteUrl,
          [...knowledge.sourceRepositories].sort(),
        ],
        ...(rebuildId ? [rebuildId] : []),
      ]),
    )
    .digest("hex")

/** True when two tree rows give the same document. */
const sameEntry = (a: TreeEntry | undefined, b: TreeEntry) =>
  !!a &&
  !a.deletedAt &&
  !a.inherit &&
  a.version === b.version &&
  a.path === b.path &&
  (a.validFrom?.getTime() ?? null) === (b.validFrom?.getTime() ?? null)

/**
 * The work of one change set: the file versions that are not stored yet,
 * and the tree rows of the paths that changed, with the tree version
 * `treeVersion`. Returns the count of the tree rows and the count of the
 * `failed` documents of the new tree. `counter` gets the count of ClickHouse
 * mutations.
 */
async function applyChangeSet(input: {
  orgId: string
  workspaceId: string
  remote: { url: string }
  root: string
  branch: string
  tip: string
  store: KnowledgeStore
  observedAt: Date
  directory: string
  plan: KnowledgeChangeSet
  projectionVersion: string
  /** The head of the branch, or null when it has no tree yet. */
  head: TreeHead | null
  /** For an overlay: the head of the default branch, its base. */
  base: TreeHead | null
  treeVersion: number
  /** A full rebuild: the id that makes its file versions new (`fileVariant`). */
  rebuildId: string | null
  introductions: FileIntroductions
  counter: MutationCounter
  embedding: EmbeddingCounter
  files: FileCounter
}): Promise<{ changed: number; failedCount: number }> {
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
  const variants = {
    knowledge: fileVariant(
      input.projectionVersion,
      { remoteUrl: input.remote.url, sourceRepositories },
      input.rebuildId,
    ),
    other: fileVariant(input.projectionVersion, null, input.rebuildId),
  }
  const keyAt = (path: string): FileVersionKey => ({
    docKey: keyOf(path),
    version: fileVersion(
      tree.get(path) ?? "",
      isKnowledgePath(path) ? variants.knowledge : variants.other,
    ),
  })
  const current = new Map(
    (input.head ? await store.readTree(scope, input.head) : []).map((entry) => [
      entry.docKey,
      entry,
    ]),
  )
  // Only regular files: a submodule, a symlink or a removed path gives no
  // document. A delta also writes each file that a commit after a fork
  // added, because its `valid_from` can change when the diff does not show
  // it.
  const files = [
    ...new Set(
      plan.kind === "full"
        ? plan.files
        : plan.kind === "overlay"
          ? plan.changed
          : [...plan.changed, ...input.introductions.addedSinceFork],
    ),
  ]
    .filter((path) => tree.has(path) && isDocumentPath(path))
    .sort()

  /** The document keys that have a file version at the tip. */
  const present = new Set<string>()
  /** The tree rows of the run. */
  const next = new Map<string, TreeEntry>()
  for (let at = 0; at < files.length; at += FILES_PER_WRITE) {
    const group = files.slice(at, at + FILES_PER_WRITE)
    const stored = await store.findFileVersions(scope, group.map(keyAt))
    // Only the files with no stored file version become rows. The blobs are
    // read 50 files at a time. The chunks of the whole group then go to the
    // embedding client in one call, so that its requests fill to the batch
    // limits.
    const unembedded: UnembeddedDocumentRows[] = []
    const failed: { path: string; error: string }[] = []
    await inBatches(
      group.filter((path) => !stored.has(fileVersionId(keyAt(path)))),
      50,
      async (batch) => {
        const rows = await projectFiles({
          directory,
          workspaceId,
          blobPath,
          sourceRepositories,
          observedAt,
          paths: batch,
          blobs: batch.map((path) => tree.get(path) ?? ""),
          store,
          scope,
          files: input.files,
        })
        unembedded.push(...rows.documents)
        failed.push(...rows.failed)
      },
    )
    const documents = await embedDocuments(
      unembedded,
      store,
      scope,
      input.embedding,
    )
    const versions: FileVersionRows[] = [
      ...documents.map((rows) => ({
        ...rows,
        ...keyAt(rows.document.path),
      })),
      ...failed.map(({ path, error }) => ({
        ...keyAt(path),
        document: failedDocument(keyOf(path), path, observedAt),
        chunks: [],
        relations: [],
        error,
      })),
    ]
    await store.writeFileVersions(scope, versions, input.counter)
    for (const { document, version, error } of versions)
      stored.set(fileVersionId({ docKey: document.docKey, version }), {
        status: error === undefined ? "active" : "failed",
        kind: document.kind,
        observedAt: document.observedAt,
        validFrom: document.validFrom,
        validTo: document.validTo,
      })
    // A knowledge file that gives no unit has no file version.
    const entries = group.flatMap((path): TreeEntry[] => {
      const key = keyAt(path)
      const version = stored.get(fileVersionId(key))
      if (!version) return []
      present.add(key.docKey)
      const entry: TreeEntry = {
        ...key,
        ...version,
        path,
        // The source time of the file version first (CTX-1516), else the
        // time of the commit that introduced the knowledge file.
        validFrom:
          version.validFrom ??
          (isKnowledgePath(path)
            ? dateOrNull(input.introductions.introducedAtByPath.get(path))
            : null),
        deletedAt: null,
      }
      return sameEntry(current.get(key.docKey), entry) ? [] : [entry]
    })
    for (const entry of entries) next.set(entry.docKey, entry)
  }

  const ends =
    plan.kind === "overlay"
      ? await overlayEnds({
          store,
          scope,
          plan,
          base: input.base,
          current,
          present,
          keyOf,
          isDocumentPath,
          observedAt,
        })
      : // A tombstone for each path whose file is gone: in a delta, the
        // paths of the diff; in a full rebuild, each path of the head (the
        // reconcile). It keeps the last file version of the path.
        (plan.kind === "full"
          ? [...current.keys()]
          : [...plan.changed, ...plan.removed].filter(isDocumentPath).map(keyOf)
        ).flatMap((docKey): TreeEntry[] => {
          const entry = current.get(docKey)
          return entry &&
            !entry.deletedAt &&
            !entry.inherit &&
            !present.has(docKey)
            ? [{ ...entry, deletedAt: observedAt }]
            : []
        })
  for (const entry of ends) next.set(entry.docKey, entry)
  // All tree rows go in one INSERT at the end, just before the head moves:
  // their `written_at` is then the time of the new head, within seconds,
  // and the grace times of the cleanup count from it (ADR-071 decision 10).
  await store.writeTree(scope, input.branch, input.treeVersion, [
    ...next.values(),
  ])

  const failedCount = [...new Map([...current, ...next]).values()].filter(
    (entry) => !entry.deletedAt && !entry.inherit && entry.status === "failed",
  ).length
  return { changed: next.size, failedCount }
}

/**
 * The rows that end paths of an overlay (ADR-071 decisions 3 and 5):
 * - a path that the tip removed gets a tombstone, so that the view of the
 *   branch removes it, also when the default branch deletes the path and
 *   then adds it again. It keeps a file version of the path: the one of the
 *   default branch, else the earlier one of the branch.
 * - a path that left the overlay (the tip has it as at the merge base) gets
 *   an `inherit` row, so that the view shows the row of the default branch.
 */
async function overlayEnds(input: {
  store: KnowledgeStore
  scope: KnowledgeScope
  plan: Extract<KnowledgeChangeSet, { kind: "overlay" }>
  base: TreeHead | null
  current: ReadonlyMap<string, TreeEntry>
  /** The document keys that the overlay holds a file version for. */
  present: ReadonlySet<string>
  keyOf: (path: string) => string
  isDocumentPath: (path: string) => boolean
  observedAt: Date
}): Promise<TreeEntry[]> {
  const { current, present, keyOf } = input
  if (!input.base)
    throw new Error("An overlay needs the head of the default branch")
  const base = new Map(
    (await input.store.readTree(input.scope, input.base)).map((entry) => [
      entry.docKey,
      entry,
    ]),
  )
  // An `inherit` row holds no file version, so that the cleanup can remove
  // the file version that the branch does not use any more.
  const inherit = (docKey: string): TreeEntry[] => {
    const entry = current.get(docKey)
    return entry && !entry.inherit
      ? [{ ...entry, version: "", inherit: true }]
      : []
  }
  const ends = new Map<string, TreeEntry[]>()
  // A changed path with no file version (a knowledge file that gives no
  // unit) is no document on the branch, as a removed path.
  const gone = [
    ...input.plan.removed,
    ...input.plan.changed.filter((path) => !present.has(keyOf(path))),
  ]
  for (const path of gone.filter(input.isDocumentPath)) {
    const docKey = keyOf(path)
    const own = current.get(docKey)
    const below = base.get(docKey)
    const kept = [below, own].find((entry) => entry && !entry.inherit)
    // A tombstone of the branch stays as it is, with its first date. With
    // no stored row of the path, the tombstone has no file version: the
    // path has a tombstone with no fields.
    if (own?.deletedAt && !own.inherit) ends.set(docKey, [])
    else
      ends.set(docKey, [
        {
          ...(kept ?? {
            docKey,
            version: "",
            path,
            status: "active" as const,
            kind: "",
            observedAt: input.observedAt,
            validFrom: null,
            validTo: null,
          }),
          inherit: false,
          deletedAt: input.observedAt,
        },
      ])
  }
  const inOverlay = new Set([
    ...present,
    ...gone.filter(input.isDocumentPath).map(keyOf),
  ])
  for (const docKey of current.keys())
    if (!inOverlay.has(docKey)) ends.set(docKey, inherit(docKey))
  return [...ends.values()].flat()
}

/** The document fields of a `failed` file version: its path only. */
const failedDocument = (
  docKey: string,
  path: string,
  observedAt: Date,
): FileDocument => ({
  docKey,
  kind: "",
  title: "",
  path,
  sourceType: "",
  source: "",
  summary: "",
  mime: "",
  validFrom: null,
  validTo: null,
  observedAt,
})

const dateOrNull = (time: string | undefined) => (time ? new Date(time) : null)

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
 * The image bytes that wait for the vision step, at most (with the one
 * image that goes above it). The PNG of an SVG can be much larger than the
 * SVG, so a read group alone does not limit them.
 */
const IMAGE_BATCH_BYTES = 32 * 1024 * 1024

/**
 * The blobs in read groups of at most READ_BYTES each, with their framing,
 * and the blobs above their limit, which no group holds. A blob above
 * READ_BYTES and below its limit is a group alone.
 */
function readGroups(blobs: { blob: string; size: number; limit: number }[]): {
  groups: string[][]
  tooLarge: { blob: string; limit: number }[]
} {
  const groups: string[][] = [[]]
  const tooLarge: { blob: string; limit: number }[] = []
  let groupBytes = 0
  for (const { blob, size, limit } of blobs) {
    if (size > limit) {
      tooLarge.push({ blob, limit })
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
  return { groups, tooLarge }
}

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
  workspaceId: string
  blobPath: ReturnType<typeof workspaceBlobPath>
  sourceRepositories: Map<string, string>
  observedAt: Date
  paths: string[]
  /** The blob id of each path. */
  blobs: string[]
  store: KnowledgeStore
  scope: KnowledgeScope
  files: FileCounter
}): Promise<{
  documents: UnembeddedDocumentRows[]
  failed: { path: string; error: string }[]
}> {
  const { workspaceId, blobPath, observedAt } = input
  const documents: UnembeddedDocumentRows[] = []
  const failed: { path: string; error: string }[] = []
  const fail = (path: string, error: string) => failed.push({ path, error })
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
  const { groups, tooLarge } = readGroups(
    blobs.map((blob, index) => ({
      blob,
      size: sizes[index] ?? 0,
      limit: entriesOf.get(blob)?.some((entry) => entry.type?.kind === "image")
        ? MAX_IMAGE_BYTES
        : MAX_FILE_BYTES,
    })),
  )
  for (const { blob, limit } of tooLarge)
    for (const entry of entriesOf.get(blob) ?? []) {
      fail(entry.path, `The file is larger than ${limit / 1024 / 1024} MiB.`)
      if (entry.type)
        count(
          entry.type.kind === "image" ? "image" : entry.type.format,
          "too-large",
        )
    }
  /** The images for the vision model, with the paths and the type of each. */
  const images: {
    paths: string[]
    mime: string
    blobSha: string
    image: { bytes: Buffer; mimeType: string }
    labels?: string
  }[] = []
  let imageBytes = 0
  // The images go to the vision step at the end of each group, and when
  // they pass IMAGE_BATCH_BYTES: the run holds the bytes of one group and
  // of one batch of images at a time.
  for (const group of groups) {
    const contents = await readGitBlobs(input.directory, group)
    for (const [index, blob] of group.entries()) {
      const bytes = contents[index] ?? Buffer.alloc(0)
      // The paths of the blob by type: each type converts the blob one
      // time, also when more paths have it.
      const pathsOf = new Map<
        string,
        { type: Entry["type"]; paths: string[] }
      >()
      for (const { path, type } of entriesOf.get(blob) ?? []) {
        const key = type === null ? "" : `${type.kind}:${type.mime}`
        const same = pathsOf.get(key) ?? { type, paths: [] }
        same.paths.push(path)
        pathsOf.set(key, same)
      }
      for (const { type, paths } of pathsOf.values())
        if (type) await projectFile({ paths, blob, type, bytes })
        else {
          // The text is scrubbed before the parser and the chunker read it,
          // so a secret across a chunk boundary is found (ADR-072).
          const content = await scrubForModel(bytes.toString("utf8"))
          for (const path of paths) projectKnowledgeFile(path, content)
        }
      if (imageBytes > IMAGE_BATCH_BYTES) await projectImages()
    }
    await projectImages()
  }
  return { documents, failed }

  function projectKnowledgeFile(path: string, content: string): void {
    // The parse and the mapper read no Git and no network: an error here
    // is a content error of the file.
    try {
      const parsed = parseKnowledgeFile({
        workspaceId,
        blobPath,
        path,
        content,
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
            observedAt,
          }),
        )
    } catch (error) {
      fail(path, error instanceof Error ? error.message : String(error))
    }
  }

  /** The rows of the `paths` of one blob of one type. */
  async function projectFile(file: {
    paths: string[]
    blob: string
    type: Exclude<FileType, { kind: "unsupported" }>
    bytes: Buffer
  }): Promise<void> {
    const { paths, blob, type, bytes } = file
    if (type.kind === "image") {
      images.push({
        paths,
        mime: type.mime,
        blobSha: blob,
        image: { bytes, mimeType: type.mime },
      })
      imageBytes += bytes.length
      return
    }
    const conversion = await convertFile(type.format, bytes)
    // As for a Markdown file: scrubbed before the chunker reads it.
    const text =
      conversion.kind === "text" ? await scrubForModel(conversion.text) : ""
    for (const path of paths) {
      count(
        type.format,
        conversion.kind === "failed" ? conversion.failure : conversion.kind,
      )
      if (conversion.kind === "failed")
        fail(path, `${conversion.failure}: ${conversion.message}`)
      else if (conversion.kind === "text")
        documents.push(
          fileRows({
            workspaceId,
            path,
            kind: "document",
            mime: type.mime,
            text,
            summary: conversion.imageOnlyPages.length
              ? `The pages ${conversion.imageOnlyPages.join(", ")} have no text layer.`
              : "",
            observedAt,
          }),
        )
    }
    if (conversion.kind === "image") {
      images.push({
        paths,
        mime: type.mime,
        // The key of the cache is the SVG blob: the same SVG gives the same
        // PNG.
        blobSha: blob,
        image: { bytes: conversion.png, mimeType: "image/png" },
        labels: conversion.labels,
      })
      imageBytes += conversion.png.length
    }
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
    imageBytes = 0
    for (const { paths, mime, blobSha } of images.splice(0)) {
      const text = texts.get(blobSha)
      // The text of an image (the reading and the labels of an SVG) is
      // scrubbed before the chunker reads it, as a file text is.
      const scrubbed =
        text && !("error" in text) ? await scrubForModel(text.text) : ""
      for (const path of paths)
        if (!text || "error" in text)
          fail(path, text?.error ?? "The image has no text.")
        else
          documents.push(
            fileRows({
              workspaceId,
              path,
              kind: "image",
              mime,
              text: scrubbed,
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
  // The key hashes the scrubbed text, which is the text that the model gets.
  const inputs = await scrubForModel(
    documents.flatMap(({ document, chunks }) =>
      chunks.flatMap((chunk, index) =>
        chunk.text.trim()
          ? [
              {
                text: chunk.text,
                documentTitle: document.title,
                chunkIndex: index,
                chunkCount: chunks.length,
              },
            ]
          : [],
      ),
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
   * tip and `last_sha`.
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
 * in the diff from `last_sha`: a commit removed the file and a later commit
 * added it again, a merge brought an earlier add, or the tip went back to an
 * older commit. Then the introducing commit at the tip or at `last_sha` is
 * on one side only of their fork. `addedSinceFork` gives each path that such
 * a commit added, so the delta writes the `valid_from` of a full rebuild.
 * The walk of the fork reads only the commits after it.
 */
async function fileIntroductions(input: {
  directory: string
  remote: KnowledgeRemote
  root: string
  tip: string
  /** The `last_sha` of a delta; null for a full rebuild. */
  base: string | null
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
  if (input.base && input.base !== tip)
    for (const repositoryPath of (
      await nativeGit(directory, [
        "--no-lazy-fetch",
        "log",
        "--format=",
        "--name-only",
        "-z",
        "--diff-filter=A",
        "--no-renames",
        `${tip}...${input.base}`,
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
 * Fetch the tip, then `last_sha`. A commit that the remote does not have any
 * more (a force-push and a Git GC) stays out, so the planner sees it as
 * missing and rebuilds in full.
 */
async function fetchCommits(
  directory: string,
  remote: KnowledgeRemote,
  tip: string,
  base: string | null,
): Promise<void> {
  const token = await remote.token()
  const fetch = (sha: string) =>
    fetchGitCommits(directory, { url: remote.url, shas: [sha], token })
  await fetch(tip)
  if (!base || base === tip) return
  await fetch(base).catch((error: unknown) => {
    // Only a commit that the remote does not have: any other error is an
    // infrastructure error, and the run retries.
    if (!/not our ref/i.test(String(error))) throw error
    getLogger().warn("A commit of the knowledge state is not on the remote", {
      step: "knowledge-plane.fetch",
      sha: base,
    })
  })
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
