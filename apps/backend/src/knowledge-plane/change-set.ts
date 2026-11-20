import { isSourcesTreePath } from "../domain/workspace-sources/source-tree.js"
import { parseNameStatus } from "../services/git/name-status.js"
import { listTreeBlobs, nativeGit } from "../services/git/pack.js"
import { workspaceRelativePath } from "../services/git/root-folder.js"
import { IMAGE_TEXT_PROMPT_VERSION } from "./image-text.js"

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
  // time (CTX-1433). The converter version, the vision model and the prompt
  // version of the image text are part of it too: a new parser, model or
  // prompt gives other text for the same bytes.
  return JSON.stringify([
    7,
    input.embeddingModel,
    input.dimensions,
    input.root,
    input.converter,
    input.visionModel,
    IMAGE_TEXT_PROMPT_VERSION,
  ])
}

/** The reasons for a full rebuild instead of a delta. */
export type KnowledgeFullReason =
  /** No run has completed for the Workspace. */
  | "first_run"
  /** The projection version of the code is not the stored version. */
  | "projection_version"
  /** More than 10 runs started after `last_sha` and did not complete. */
  | "attempts"
  /** Git does not have `last_sha` or a SHA of `attempt_shas`. */
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

/** The values of the `knowledge_state` row that the planner reads. */
export type KnowledgePlanState = {
  lastSha: string | null
  attemptShas: readonly string[]
  projectionVersion: string | null
}

/**
 * Plan the change set of a knowledge run (ADR-067 decision 4). The run must
 * add `tip` to `attempt_shas` before it writes (`beginKnowledgeRun`). The
 * delta is the union of the diffs from `last_sha` to each SHA of
 * `attempt_shas` and to `tip`. The diffs to the SHAs of failed runs give the
 * files that those runs can have changed, also when a later commit changed a
 * file back.
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
  const targets = [...new Set([...state.attemptShas, tip])]
  if (targets.length > 10) return full("attempts")
  const base = state.lastSha
  if (!(await hasCommits(directory, [base, ...targets])))
    return full("missing_commit")

  // The status of each path in the diff to the tip, and in the diffs to the
  // other SHAs. `--no-renames` gives a rename as a removal and an addition.
  const toTip = await diffPaths(directory, root, base, tip)
  const others = new Map<string, DiffStatus>()
  for (const sha of targets)
    if (sha !== tip)
      for (const [path, status] of await diffPaths(directory, root, base, sha))
        if (!toTip.has(path)) others.set(path, status)
  if ([...toTip.keys(), ...others.keys()].some(isSourcesTreePath))
    return full("sources_config")

  const changed: string[] = []
  const removed: string[] = []
  for (const [path, status] of toTip)
    (status === "D" ? removed : changed).push(path)
  // A path that only a failed run changed is the same at the tip as at
  // `last_sha`. When that run added it, the tip does not have it.
  for (const [path, status] of others)
    (status === "A" ? removed : changed).push(path)
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
