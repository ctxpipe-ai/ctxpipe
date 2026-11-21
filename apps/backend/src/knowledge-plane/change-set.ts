import { isSourcesTreePath } from "../domain/workspace-sources/source-tree.js"
import { parseNameStatus } from "../services/git/name-status.js"
import { listTreeBlobs, nativeGit } from "../services/git/pack.js"
import { workspaceRelativePath } from "../services/git/root-folder.js"
import { IMAGE_TEXT_PROMPT_VERSION } from "./image-text.js"
import { isKnowledgePath } from "./parse-file.js"

/**
 * The projection version of the knowledge plane (ADR-067 decision 4): a code
 * version, the embedding model id and its dimension, and the Workspace root
 * folder. A change of any of them starts a full rebuild of the Workspace,
 * because the Git diff cannot show it.
 */
export function knowledgeProjectionVersion(input: {
  embeddingModel: string
  dimensions: number
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  /** The version of the file converter (`converterVersion`). */
  converter: string
  /** The vision model (`imageTextModel`). */
  visionModel: string
}): string {
  // Increase the code version when the parser, the chunking or the mapper
  // changes. 2: the reference keys of CTX-1400. 3: image vectors and the alt
  // text of EMBEDS_IMAGE (CTX-1412). 4: the ClickHouse migration 0007 made
  // the tables again, empty (CTX-1417). 5: `valid_from` from the commit that
  // introduced the file (CTX-1421). 6: one text vector space, and an image
  // document has no chunk (CTX-1431). 7: files become text at projection
  // time (CTX-1433). 8: file versions and trees (ADR-071): the ClickHouse
  // migration 0010 made the tables again, empty. The converter version, the
  // vision model and the prompt version of the image text are part of it
  // too: a new parser, model or prompt gives other text for the same bytes.
  return JSON.stringify([
    8,
    input.embeddingModel,
    input.dimensions,
    input.root,
    input.converter,
    input.visionModel,
    IMAGE_TEXT_PROMPT_VERSION,
  ])
}

/**
 * The Workspace root folder of a projection version
 * (`knowledgeProjectionVersion`), or null for a version in another form.
 */
export function knowledgeProjectionRoot(version: string): string | null {
  try {
    const parts: unknown = JSON.parse(version)
    return Array.isArray(parts) && typeof parts[3] === "string"
      ? parts[3]
      : null
  } catch {
    return null
  }
}

/** The reasons for a full rebuild instead of a delta. */
export type KnowledgeFullReason =
  /** No run has completed for the Workspace. */
  | "first_run"
  /** The projection version of the code is not the stored version. */
  | "projection_version"
  /** The tree of the branch is an overlay, and the branch is now the default branch. */
  | "branch"
  /** Git does not have `last_sha`. */
  | "missing_commit"
  /** A diff changes the sources (ADR-050): `.ctxpipe/sources.yaml` or `sources/`. */
  | "sources_config"

/**
 * The files that a run must apply. A delta gives the files that changed and
 * the files that are not in the tip tree. A full rebuild gives every file of
 * the tip tree, so that the writer can make each other document a tombstone.
 * All paths are relative to the Workspace root folder.
 */
export type KnowledgeChangeSet =
  | { kind: "delta"; changed: string[]; removed: string[] }
  | { kind: "full"; reason: KnowledgeFullReason; files: string[] }
  /**
   * The overlay of a branch that is not the default branch (ADR-071
   * decision 3): `changed` are the paths whose file at the tip differs from
   * the merge base, `removed` the paths that the tip does not have.
   */
  | { kind: "overlay"; changed: string[]; removed: string[] }

/** The values of the `knowledge_state` row that the planner reads. */
export type KnowledgePlanState = {
  lastSha: string | null
  /** The merge base of an overlay; null for a full tree. */
  mergeBase: string | null
  projectionVersion: string | null
}

/**
 * Plan the change set of a knowledge run (ADR-067 decision 4): the diff from
 * `last_sha` to `tip`. A run that stopped wrote only tree rows above the
 * head, which the next run deletes first (ADR-071 decision 4), so the diff
 * from the head is complete.
 */
export async function planKnowledgeChangeSet(input: {
  /** A Git directory that has the commits of the state and the tip. */
  directory: string
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  /** The state row, or null when the Workspace has no row. */
  state: KnowledgePlanState | null
  tip: string
  /** The current version (`knowledgeProjectionVersion`). */
  projectionVersion: string
}): Promise<KnowledgeChangeSet> {
  const { directory, root, state, tip } = input
  const full = async (reason: KnowledgeFullReason) => ({
    kind: "full" as const,
    reason,
    files: (
      await listTreeBlobs(directory, tip, root ? [`${root}/`] : undefined)
    )
      .flatMap(({ path }) => workspaceRelativePath(root, path) ?? [])
      .sort(),
  })
  if (!state?.lastSha) return full("first_run")
  if (state.projectionVersion !== input.projectionVersion)
    return full("projection_version")
  if (state.mergeBase !== null) return full("branch")
  const base = state.lastSha
  if (!(await hasCommits(directory, [base, tip]))) return full("missing_commit")

  // `--no-renames` gives a rename as a removal and an addition.
  const toTip = await diffPaths(directory, root, base, tip)
  if ([...toTip.keys()].some(isSourcesTreePath)) return full("sources_config")
  const changed: string[] = []
  const removed: string[] = []
  for (const [path, status] of toTip)
    (status === "D" ? removed : changed).push(path)
  return { kind: "delta", changed: changed.sort(), removed: removed.sort() }
}

/**
 * True when Git has each commit. `cat-file --batch-check` answers `missing`
 * for an object that is not there, with exit code 0, so an expected missing
 * commit is not logged as a Git failure.
 */
async function hasCommits(
  directory: string,
  shas: readonly string[],
): Promise<boolean> {
  const output = await nativeGit(
    directory,
    ["--no-lazy-fetch", "cat-file", "--batch-check=%(objecttype)"],
    shas.map((sha) => `${sha}^{commit}\n`).join(""),
  )
  return output
    .toString()
    .split("\n")
    .slice(0, shas.length)
    .every((line) => line === "commit")
}

/** The status of a path in `diff-tree --no-renames`: added, modified, deleted, or a type change. */
type DiffStatus = "A" | "M" | "D" | "T"

/** The status of each root-relative path that changed. */
async function diffPaths(
  directory: string,
  root: string,
  from: string,
  to: string,
): Promise<Map<string, DiffStatus>> {
  const output = await nativeGit(directory, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--name-status",
    from,
    to,
    ...(root ? ["--", `${root}/`] : []),
  ])
  return new Map(
    parseNameStatus(output).flatMap(({ status, to: path }) => {
      const relative = workspaceRelativePath(root, path)
      return relative === null
        ? []
        : [[relative, status.charAt(0) as DiffStatus] as const]
    }),
  )
}

/**
 * Plan the overlay of a branch that is not the default branch (ADR-071
 * decision 3): the diff from `mergeBase` (the merge base of the tip and the
 * default branch) to `tip`. The writer compares it with the stored overlay,
 * so the plan is the same for a first run and for each later run. When the
 * diff changes the sources (ADR-050), each knowledge file of the tip is in
 * `changed`: its rows come from the sources, so its file version differs
 * from the one of the default branch.
 */
export async function planOverlay(input: {
  directory: string
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  mergeBase: string
  tip: string
}): Promise<Extract<KnowledgeChangeSet, { kind: "overlay" }>> {
  const { directory, root, mergeBase, tip } = input
  const diff = await diffPaths(directory, root, mergeBase, tip)
  const changed = new Set<string>()
  const removed: string[] = []
  for (const [path, status] of diff)
    if (status === "D") removed.push(path)
    else changed.add(path)
  if ([...diff.keys()].some(isSourcesTreePath))
    for (const { path } of await listTreeBlobs(
      directory,
      tip,
      root ? [`${root}/`] : undefined,
    )) {
      const relative = workspaceRelativePath(root, path)
      if (relative !== null && isKnowledgePath(relative)) changed.add(relative)
    }
  return {
    kind: "overlay",
    changed: [...changed].sort(),
    removed: removed.sort(),
  }
}

/** The object id of the empty tree of Git (SHA-1). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * The merge base of `tip` and `defaultTip`. A branch with no commit in
 * common with the default branch has the empty tree as its base, so its
 * overlay holds each of its files.
 */
export async function mergeBaseOf(
  directory: string,
  tip: string,
  defaultTip: string,
): Promise<string> {
  const output = await nativeGit(directory, [
    "--no-lazy-fetch",
    "merge-base",
    tip,
    defaultTip,
  ]).catch((error: unknown) => {
    // `git merge-base` exits with 1 and prints nothing when there is no
    // common commit. Each other failure is an infrastructure error.
    if ((error as { code?: unknown }).code === 1) return Buffer.from("")
    throw error
  })
  return output.toString().trim() || EMPTY_TREE
}
