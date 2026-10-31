import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { stringify } from "yaml"

import { workspaceRelativePath } from "../../services/git/root-folder.js"
import { parseYamlObject, splitFrontMatter } from "./front-matter.js"
import {
  disallowedPathReason,
  MAX_WORKSPACE_OPS,
  type PatchRejection,
  type PatchRule,
  type PatchStepInput,
  type PatchStepResult,
  validatePatchStep,
} from "./patch-validator.js"
import { runGit } from "./run-git.js"

/**
 * Run-scoped ingest refs (CTX-584 T08, ADR-052 section 6, concept section 7).
 * Each step of an ingestion run adds one commit to a ref in the Workspace
 * repository. The broker is the only pusher. It never forces a push, it never
 * changes a branch, and it starts no hydrate.
 *
 * Names: `refs/ctxpipe/ingest/<runId>/<workspaceId>/shards/<shard>` for a
 * shard and `refs/ctxpipe/ingest/<runId>/<workspaceId>/assembled` for the
 * assembled result. Git cannot hold a ref `a/b` next to a ref `a/b/c`, so the
 * assembled ref has its own last segment.
 */

const INGEST_REF_ROOT = "refs/ctxpipe/ingest/"

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DAY_MS = 24 * 60 * 60 * 1000
const STEP_AUTHOR = { name: "ctxpipe", email: "ingest@ctxpipe.ai" }
const PUSH_ATTEMPTS = 3

type IngestRefTarget = {
  runId: string
  workspaceId: string
  shard?: string
}

/** A remote and the git environment (credentials) to reach it. */
export type IngestRemote = { url: string; env?: NodeJS.ProcessEnv }

/**
 * A fixed code of the cause of a refusal, for the logs: a rule of the patch
 * validator, or a check of the broker. The message can hold model or
 * customer text; the code holds none.
 */
type IngestRefusalRule = PatchRule | "admission" | "run_tip" | "merge_paths"

/**
 * A merged file that a publish withholds (CTX-1081): the file keeps its
 * version on the default tip. `rules` holds each validator rule that
 * rejected it, sorted.
 */
export type WithheldFile = { path: string; rules: PatchRule[] }

/**
 * One validator rule and reason of the withheld files of a publish, with the
 * count of files that it rejected (CTX-1099). It holds no path, so the log
 * can keep it.
 */
type WithheldReason = { rule: PatchRule; reason: string; files: number }

/** The broker refused the job. Do not retry the same job. */
export class IngestRefRefusedError extends Error {
  constructor(
    message: string,
    /** The codes of the causes; empty when no code applies. */
    readonly rules: readonly IngestRefusalRule[] = [],
  ) {
    super(message)
    this.name = "IngestRefRefusedError"
  }
}

/**
 * The ref is not at the old tip that the push expected: another push moved
 * it. Another execution of the same child can move the ref (CTX-1073). The
 * next attempt of the step reads the ref again and continues from its tip.
 */
export class IngestRefMovedError extends IngestRefRefusedError {
  constructor() {
    super("The ref is not at the expected old tip")
    this.name = "IngestRefMovedError"
  }
}

/** Two shards change the same path. The semantic merge child resolves it. */
export class IngestAssembleConflictError extends IngestRefRefusedError {
  constructor(readonly paths: string[]) {
    super(`Two shards change the same path: ${paths.join(", ")}`)
    this.name = "IngestAssembleConflictError"
  }
}

export function ingestRefName(target: IngestRefTarget): string {
  if (
    !SEGMENT.test(target.runId) ||
    !SEGMENT.test(target.workspaceId) ||
    (target.shard !== undefined && !SEGMENT.test(target.shard))
  )
    throw new Error("Unsafe ingest ref segment")
  return target.shard === undefined
    ? `${INGEST_REF_ROOT}${target.runId}/${target.workspaceId}/assembled`
    : `${INGEST_REF_ROOT}${target.runId}/${target.workspaceId}/shards/${target.shard}`
}

export function parseIngestRef(name: string): IngestRefTarget | null {
  if (!name.startsWith(INGEST_REF_ROOT)) return null
  const parts = name.slice(INGEST_REF_ROOT.length).split("/")
  const [runId = "", workspaceId = "", kind, shard] = parts
  if (!SEGMENT.test(runId) || !SEGMENT.test(workspaceId)) return null
  if (parts.length === 3 && kind === "assembled") return { runId, workspaceId }
  if (parts.length === 4 && kind === "shards" && SEGMENT.test(shard ?? ""))
    return { runId, workspaceId, shard }
  return null
}

export type IngestStepCommit = {
  /** The step name, for example `skill:<root>:<skill>:<workspaceId>`. */
  step: string
  bundle: string
  /** From the run input, so that a replay makes the same SHA. Never an age. */
  authorTime: Date
  /** The step's `patch.json` says that files wait: the `Ctxpipe-More` trailer. */
  more?: boolean
}

export type IngestJob = { runId: string; workspaceId: string }

export type PushIngestStepInput = {
  /** The run and the Workspace of the job. The ref must belong to both. */
  job: IngestJob
  ref: string
  /** The ref tip that the job expects; null when the ref must not exist. */
  oldTip: string | null
  /** The base of the first commit on a ref. */
  pinnedRevision: string
  /** The commit that the sandbox staged against (`step.json`). */
  baseCommit: string
  remote: IngestRemote
  commit: IngestStepCommit
  patch: Omit<PatchStepInput, "repoDir" | "baseCommit" | "bundle">
}

function assertJobRef(job: IngestJob, ref: string): IngestRefTarget {
  const target = parseIngestRef(ref)
  if (
    !target ||
    target.runId !== job.runId ||
    target.workspaceId !== job.workspaceId
  )
    throw new IngestRefRefusedError(
      "The ref is not an ingest ref of the job's run and Workspace",
    )
  return target
}

/**
 * The step job: validate the staged step against the base commit, commit the
 * accepted tree with fixed author data and trailers, and push it only when the
 * remote ref is at the expected old tip. A replay of a pushed step returns the
 * same SHA.
 */
export async function pushIngestStep(
  input: PushIngestStepInput,
): Promise<{ sha: string; validation: PatchStepResult; more: boolean }> {
  assertJobRef(input.job, input.ref)
  const base = input.oldTip ?? input.pinnedRevision
  if (input.baseCommit !== base)
    throw new IngestRefRefusedError(
      "The step was staged against another commit than the old tip",
    )
  return withScratchRepository(async (repoDir) => {
    await fetchCommits(repoDir, input.remote, [base], { blobs: true })
    const validation = await validatePatchStep({
      ...input.patch,
      repoDir,
      baseCommit: base,
      bundle: input.commit.bundle,
    })
    const sha = await commitStep(repoDir, {
      tree: validation.tree,
      parents: [base],
      runId: input.job.runId,
      ...input.commit,
      more: validation.more,
      rejects: validation.rejections.length,
    })
    await pushWithLease(repoDir, input.remote, input.ref, input.oldTip, sha)
    return { sha, validation, more: validation.more }
  })
}

/**
 * The assemble job: one commit whose parents are the shard tips, on the
 * pinned revision plus the ops of each shard. Each op must be a valid path
 * against the pinned revision. Two shards that change one path are a conflict:
 * the broker refuses, and the run sends them to the semantic merge child.
 * There is no per-step op cap; the run cap of a Workspace applies, and it
 * counts the `opsBefore` that the run wrote before the shards.
 */
export async function pushIngestAssemble(input: {
  job: IngestJob
  pinnedRevision: string
  /**
   * The shard tips from the step outputs; null when the output has no tip.
   * Assemble takes each tip from the shard ref: another execution of the same
   * shard child can move the ref past the output tip (CTX-1073).
   */
  shards: Array<{ shard: string; tip: string | null }>
  /** The assembled ref tip that the job expects; null for a new ref. */
  oldTip: string | null
  /** The accepted ops of the run in the Workspace before the shards. */
  opsBefore?: number
  remote: IngestRemote
  commit: IngestStepCommit
  /** Workspace root folder; `""` (the default) is the repository root. */
  rootPath?: string
  /**
   * The semantic merge of the paths that two shards change: `resolve` gets
   * each conflict (`current` is the result so far, `incoming` the next
   * shard's version) and returns the content of each path, or null for a
   * delete. The merged files then go through the patch validator against
   * the pinned revision, with `source`, `sourcePathExists`, and
   * `readSourceFile` for the evidence, and `sourcePath` for the ownership;
   * one rejected file refuses the job.
   * Without it, a conflict refuses the job.
   */
  semanticMerge?: {
    resolve: IngestConflictResolver
  } & Pick<
    PatchStepInput,
    "source" | "sourcePath" | "sourcePathExists" | "readSourceFile"
  >
}): Promise<{ sha: string; ops: number }> {
  const rootPath = input.rootPath ?? ""
  const ref = ingestRefName({
    runId: input.job.runId,
    workspaceId: input.job.workspaceId,
  })
  const shards = [...input.shards].sort((a, b) =>
    a.shard.localeCompare(b.shard, "en", { numeric: true }),
  )
  return withScratchRepository(async (repoDir) => {
    const listed = new Map(
      (await listIngestRefs(repoDir, input.remote)).map((r) => [r.name, r.sha]),
    )
    const resolved: Array<{ shard: string; tip: string }> = []
    for (const { shard, tip } of shards) {
      const name = ingestRefName({ ...input.job, shard })
      const onRemote = listed.get(name)
      if (!onRemote) {
        // A shard that pushed nothing, in any execution, has no ref.
        if (tip === null) continue
        throw new IngestRefRefusedError(`The shard ref ${shard} is missing`)
      }
      resolved.push({
        shard,
        tip: await checkedRunTip(repoDir, input.remote, {
          runId: input.job.runId,
          label: `shard ref ${shard}`,
          given: tip,
          onRemote,
        }),
      })
    }
    const tips = resolved.map((s) => s.tip)
    await fetchCommits(repoDir, input.remote, [input.pinnedRevision], {
      blobs: true,
    })
    // A replay after the push: the semantic merge may not give the same
    // content again, so the run's assemble commit on the ref is the result.
    const pushed = listed.get(ref)
    if (pushed && pushed !== input.oldTip) {
      await runGit(
        repoDir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--filter=blob:none",
          "--",
          input.remote.url,
          pushed,
        ],
        { env: input.remote.env },
      )
      const trailers = await stepTrailers(repoDir, pushed)
      if (
        trailers.run === input.job.runId &&
        trailers.step === input.commit.step
      )
        return {
          sha: pushed,
          ops: (await diffTree(repoDir, input.pinnedRevision, pushed)).length,
        }
    }
    if (tips.length)
      await runGit(
        repoDir,
        ["fetch", "--quiet", "--no-tags", "--", input.remote.url, ...tips],
        { env: input.remote.env },
      )

    const changes = new Map<
      string,
      { path: string; line: string; versions: Array<string | null> }
    >()
    for (const { shard, tip } of resolved) {
      const descends = await runGit(repoDir, [
        "merge-base",
        "--is-ancestor",
        input.pinnedRevision,
        tip,
      ]).then(
        () => true,
        () => false,
      )
      if (!descends)
        throw new IngestRefRefusedError(
          `The shard ${shard} does not start at the pinned revision`,
        )
      for (const change of await diffTree(repoDir, input.pinnedRevision, tip)) {
        const relative = workspaceRelativePath(rootPath, change.path)
        const reason =
          relative === null
            ? "The path is outside the Workspace root folder"
            : (disallowedPathReason(relative) ??
              (change.regularFile ? null : "Only regular files are allowed"))
        if (reason) throw new IngestRefRefusedError(`${change.path}: ${reason}`)
        const key = change.path.toLowerCase()
        const same = changes.get(key)
        if (same) same.versions.push(change.blob)
        else
          changes.set(key, {
            path: change.path,
            line: change.indexLine,
            versions: [change.blob],
          })
      }
    }
    const conflicts = [...changes.values()].filter((c) => c.versions.length > 1)
    if (conflicts.length && !input.semanticMerge)
      throw new IngestAssembleConflictError(conflicts.map((c) => c.path))
    const opsBefore = input.opsBefore ?? 0
    if (opsBefore + changes.size > MAX_WORKSPACE_OPS)
      throw new IngestRefRefusedError(
        `The run writes ${opsBefore + changes.size} ops; a Workspace takes at most ${MAX_WORKSPACE_OPS} in a run`,
      )

    const indexEnv = { GIT_INDEX_FILE: join(repoDir, "assemble.index") }
    await runGit(repoDir, ["read-tree", input.pinnedRevision], {
      env: indexEnv,
    })
    await runGit(repoDir, ["update-index", "-z", "--index-info"], {
      env: indexEnv,
      input: [...changes.values()]
        .filter((c) => c.versions.length === 1)
        .map((c) => c.line)
        .join(""),
    })
    let tree = (await runGit(repoDir, ["write-tree"], { env: indexEnv }))
      .toString()
      .trim()
    if (conflicts.length && input.semanticMerge) {
      const merged = await mergeConflicts(repoDir, {
        pinnedRevision: input.pinnedRevision,
        tree,
        conflicts,
        opsBefore: opsBefore + changes.size - conflicts.length,
        bundle: input.commit.bundle,
        merge: input.semanticMerge,
        rootPath,
      })
      if (merged.rejections.length)
        throw new IngestRefRefusedError(
          `The semantic merge result fails the patch validator: ${merged.rejections
            .slice(0, 5)
            .map((r) => `${r.path}: ${r.rule}: ${r.reason}`)
            .join("; ")}`,
          [...new Set(merged.rejections.map((r) => r.rule))].sort(),
        )
      tree = merged.tree
    }
    const sha = await commitStep(repoDir, {
      tree,
      parents: tips.length ? tips : [input.pinnedRevision],
      runId: input.job.runId,
      ...input.commit,
    })
    await pushWithLease(repoDir, input.remote, ref, input.oldTip, sha)
    return { sha, ops: changes.size }
  })
}

/**
 * The files of a publish (T21, ADR-052 section 6): the delta from the pinned
 * revision to the assembled tip of the run, replayed on `current`, the
 * default tip. The tip must be a commit of the run (its `Ctxpipe-Run`
 * trailer). A delete of a file whose host `root` is in `withheldRoots` stays
 * out: a failed root gets no retraction (concept section 7.3).
 *
 * A path that the run and the default branch both changed after the pin goes
 * to `semanticMerge.resolve`, and its result goes through the patch
 * validator on `current`, as in assemble. A rejected file is withheld: it
 * keeps its version on `current`, and the other files publish (CTX-1081).
 * Each other path is the run's file, which passed the validator in its
 * step. Returns the files and deletes from `current`, the withheld files
 * with the validator rule that rejected each, and each rule and reason of
 * the withheld files with its count of files.
 */
export async function mergeIngestPublish(input: {
  runId: string
  pinnedRevision: string
  tip: string
  current: string
  withheldRoots: readonly string[]
  bundle: string
  remote: IngestRemote
  semanticMerge: NonNullable<
    Parameters<typeof pushIngestAssemble>[0]["semanticMerge"]
  >
}): Promise<{
  files: Array<{ path: string; content: string; encoding?: "base64" }>
  deletePaths: string[]
  withheld: WithheldFile[]
  withheldReasons: WithheldReason[]
}> {
  return withScratchRepository(async (repoDir) => {
    await fetchCommits(
      repoDir,
      input.remote,
      [...new Set([input.pinnedRevision, input.tip, input.current])],
      { blobs: true },
    )
    if ((await stepTrailers(repoDir, input.tip)).run !== input.runId)
      throw new IngestRefRefusedError(
        "The assembled tip is not a commit of the ingestion run",
        ["run_tip"],
      )
    const text = async (spec: string) =>
      (await runGit(repoDir, ["cat-file", "blob", spec])).toString("utf8")
    const withheld = new Set(input.withheldRoots)
    const moved = new Map(
      (await diffTree(repoDir, input.pinnedRevision, input.current)).map(
        (change) => [change.path.toLowerCase(), change.blob],
      ),
    )
    const clean: string[] = []
    const conflicts: Array<{ path: string; versions: Array<string | null> }> =
      []
    for (const change of await diffTree(
      repoDir,
      input.pinnedRevision,
      input.tip,
    )) {
      const reason = disallowedPathReason(change.path)
      if (reason)
        throw new IngestRefRefusedError(`${change.path}: ${reason}`, ["path"])
      if (change.blob === null && withheld.size) {
        const front = splitFrontMatter(
          await text(`${input.pinnedRevision}:${change.path}`),
        )
        const root = front ? parseYamlObject(front.yaml)?.root : undefined
        if (typeof root === "string" && withheld.has(root)) continue
      }
      const key = change.path.toLowerCase()
      if (!moved.has(key)) clean.push(change.indexLine)
      else if (moved.get(key) !== change.blob)
        conflicts.push({
          path: change.path,
          versions: [moved.get(key) ?? null, change.blob],
        })
    }

    const indexEnv = { GIT_INDEX_FILE: join(repoDir, "publish.index") }
    await runGit(repoDir, ["read-tree", input.current], { env: indexEnv })
    await runGit(repoDir, ["update-index", "-z", "--index-info"], {
      env: indexEnv,
      input: clean.join(""),
    })
    let tree = (await runGit(repoDir, ["write-tree"], { env: indexEnv }))
      .toString()
      .trim()
    const withheldFiles: WithheldFile[] = []
    const withheldReasons: WithheldReason[] = []
    if (conflicts.length) {
      const merged = await mergeConflicts(repoDir, {
        pinnedRevision: input.pinnedRevision,
        tree,
        conflicts,
        // The run cap counted these paths in the run's steps.
        opsBefore: 0,
        bundle: input.bundle,
        merge: input.semanticMerge,
        // The publish reads whole-repository paths.
        rootPath: "",
      })
      tree = merged.tree
      const rulesOf = new Map<string, Set<PatchRule>>()
      const byReason = new Map<
        string,
        { rule: PatchRule; reason: string; paths: Set<string> }
      >()
      for (const { path, rule, reason } of merged.rejections) {
        rulesOf.set(path, (rulesOf.get(path) ?? new Set()).add(rule))
        // A reason can hold a line number (a secret), so one cause can give
        // more than one entry.
        const key = `${rule}\n${reason}`
        const entry = byReason.get(key) ?? { rule, reason, paths: new Set() }
        byReason.set(key, entry)
        entry.paths.add(path)
      }
      for (const [path, rules] of rulesOf)
        withheldFiles.push({ path, rules: [...rules].sort() })
      for (const { rule, reason, paths } of byReason.values())
        withheldReasons.push({ rule, reason, files: paths.size })
    }

    const files: Array<{ path: string; content: string; encoding?: "base64" }> =
      []
    const deletePaths: string[] = []
    for (const change of await diffTree(repoDir, input.current, tree)) {
      if (change.blob === null) {
        deletePaths.push(change.path)
        continue
      }
      const bytes = await runGit(repoDir, ["cat-file", "blob", change.blob])
      const utf8 = bytes.toString("utf8")
      files.push(
        Buffer.from(utf8, "utf8").equals(bytes)
          ? { path: change.path, content: utf8 }
          : {
              path: change.path,
              content: bytes.toString("base64"),
              encoding: "base64",
            },
      )
    }
    return { files, deletePaths, withheld: withheldFiles, withheldReasons }
  })
}

/**
 * The tip of an ingest ref of the run, read from the remote: `given`, or a
 * later commit of the run that another execution of the same child pushed
 * (CTX-1073). A missing ref gives `given`. A tip that is not a commit of the
 * run, or that does not hold `given`, refuses the job.
 */
export async function ingestRunRefTip(input: {
  remote: IngestRemote
  ref: string
  runId: string
  given: string
}): Promise<string> {
  return withScratchRepository(async (repoDir) => {
    const onRemote = await remoteTip(repoDir, input.remote, input.ref)
    if (!onRemote) return input.given
    return checkedRunTip(repoDir, input.remote, {
      runId: input.runId,
      label: `ref ${input.ref}`,
      given: input.given,
      onRemote,
    })
  })
}

/**
 * The remote tip of an ingest ref, when it is `given` or a later commit of
 * the run. `label` names the ref in a refusal.
 */
async function checkedRunTip(
  repoDir: string,
  remote: IngestRemote,
  input: {
    runId: string
    label: string
    given: string | null
    /** The tip of the ref on the remote. */
    onRemote: string
  },
): Promise<string> {
  if (input.onRemote === input.given) return input.onRemote
  await runGit(
    repoDir,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      "--",
      remote.url,
      input.onRemote,
    ],
    { env: remote.env },
  )
  await assertRunTip(repoDir, {
    runId: input.runId,
    label: input.label,
    since: input.given,
    tip: input.onRemote,
  })
  return input.onRemote
}

/**
 * Refuses `tip` unless it is a commit of the run that holds `since`. The ref
 * moves only by leased fast-forward pushes, so a later tip of the run holds
 * each earlier tip. Both commits must be in `repoDir`.
 */
async function assertRunTip(
  repoDir: string,
  input: { runId: string; label: string; since: string | null; tip: string },
): Promise<void> {
  if ((await stepTrailers(repoDir, input.tip)).run !== input.runId)
    throw new IngestRefRefusedError(
      `The tip of ${input.label} is not a commit of the run`,
    )
  if (input.since === null) return
  const holds = await runGit(repoDir, [
    "merge-base",
    "--is-ancestor",
    input.since,
    input.tip,
  ]).then(
    () => true,
    () => false,
  )
  if (!holds)
    throw new IngestRefRefusedError(
      `The ${input.label} does not hold the given tip`,
    )
}

/**
 * Resume: the run's commits on the ref after `since`, the tip that the step
 * starts from. When one of them is the commit of `step` (a crash after the
 * push, or another execution of the same child that pushed the step,
 * CTX-1073), it gives that commit. Else it gives the tip that another
 * execution moved the ref to. It gives null when the ref is at `since` or
 * missing. `ops` counts the paths that changed after `since`.
 */
export async function findStepCommit(input: {
  remote: IngestRemote
  ref: string
  runId: string
  step: string
  since: string
}): Promise<
  | { sha: string; ops: number; rejects: number; more: boolean }
  | { tip: string; ops: number }
  | null
> {
  return withScratchRepository(async (repoDir) => {
    const tip = await remoteTip(repoDir, input.remote, input.ref)
    if (!tip || tip === input.since) return null
    const fetch = (sha: string, depth: string[]) =>
      runGit(
        repoDir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          ...depth,
          "--filter=blob:none",
          "--",
          input.remote.url,
          sha,
        ],
        { env: input.remote.env },
      )
    // `since` is the shallow boundary: the second fetch stops there.
    await fetch(input.since, ["--depth=1"])
    await fetch(tip, [])
    await assertRunTip(repoDir, {
      runId: input.runId,
      label: `ref ${input.ref}`,
      since: input.since,
      tip,
    })
    const commits = (
      await runGit(repoDir, ["rev-list", "--reverse", `${input.since}..${tip}`])
    )
      .toString()
      .split("\n")
      .filter(Boolean)
    for (const sha of commits) {
      const trailers = await stepTrailers(repoDir, sha)
      if (trailers.run === input.runId && trailers.step === input.step)
        return {
          sha,
          ops: (await diffTree(repoDir, input.since, sha)).length,
          rejects: trailers.rejects,
          more: trailers.more,
        }
    }
    return { tip, ops: (await diffTree(repoDir, input.since, tip)).length }
  })
}

/**
 * The paths that each step commit of the run added or changed, from the
 * pinned revision to `tip` (an assembled tip holds every shard's steps). The
 * repository-wide steps get the root-to-file map from it (ADR-052 section 6).
 */
export async function listStepFiles(input: {
  remote: IngestRemote
  runId: string
  pinnedRevision: string
  tip: string
}): Promise<Array<{ step: string; paths: string[] }>> {
  return withScratchRepository(async (repoDir) => {
    const fetch = (sha: string, depth: string[]) =>
      runGit(
        repoDir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          ...depth,
          "--filter=blob:none",
          "--",
          input.remote.url,
          sha,
        ],
        { env: input.remote.env },
      )
    // The pinned revision is the shallow boundary: the second fetch stops there.
    await fetch(input.pinnedRevision, ["--depth=1"])
    await fetch(input.tip, [])
    const out = (
      await runGit(repoDir, [
        "-c",
        "core.quotePath=false",
        "log",
        "--no-renames",
        "--diff-filter=AMT",
        "--name-only",
        "--format=%x1e%(trailers:key=Ctxpipe-Run,valueonly,unfold)%x1f%(trailers:key=Ctxpipe-Step,valueonly,unfold)%x1f",
        `${input.pinnedRevision}..${input.tip}`,
      ])
    ).toString("utf8")
    return out
      .split("\x1e")
      .slice(1)
      .flatMap((record) => {
        const [run = "", step = "", names = ""] = record.split("\x1f")
        const paths = names.split("\n").filter(Boolean)
        return run.trim() === input.runId && step.trim() && paths.length
          ? [{ step: step.trim(), paths }]
          : []
      })
  })
}

/** Deletes the refs of one run in one Workspace repository. Idempotent. */
export async function deleteRunIngestRefs(input: {
  remote: IngestRemote
  runId: string
  workspaceId: string
}): Promise<string[]> {
  return withScratchRepository(async (repoDir) => {
    const refs = (await listIngestRefs(repoDir, input.remote)).filter(
      (ref) =>
        ref.target?.runId === input.runId &&
        ref.target.workspaceId === input.workspaceId,
    )
    return (await deleteRefs(repoDir, input.remote, refs)).deleted
  })
}

/** What the clean-up needs to know about one run. */
export type IngestRunState = {
  unfinished: boolean
  finishedAt: Date | null
  shadow: boolean
}

/**
 * Stale-ref clean-up for the Workspace tip check (concept section 7.4):
 * - an unfinished run keeps all of its refs;
 * - a finished run loses its refs, but a shadow run keeps them for 7 days
 *   after it finished;
 * - a ref of an unknown run, or with a name that does not parse, goes when
 *   its tip commit is older than 24 hours. No live run depends on such a ref,
 *   so its commit time is a safe age.
 * The listing uses `remote` (a read credential). `pushRemote` gives the write
 * credential and is called only when there is a ref to delete.
 */
export async function cleanUpIngestRefs(input: {
  remote: IngestRemote
  pushRemote?: () => Promise<IngestRemote>
  now: Date
  runStates: (runIds: string[]) => Promise<Map<string, IngestRunState>>
}): Promise<{ deleted: string[]; skipped: string[] }> {
  return withScratchRepository(async (repoDir) => {
    const refs = await listIngestRefs(repoDir, input.remote)
    if (!refs.length) return { deleted: [], skipped: [] }
    const runIds = [
      ...new Set(refs.flatMap((ref) => (ref.target ? [ref.target.runId] : []))),
    ]
    const states = runIds.length
      ? await input.runStates(runIds)
      : new Map<string, IngestRunState>()
    const orphans = refs.filter(
      (ref) => !ref.target || !states.has(ref.target.runId),
    )
    const commitTimes = await tipTimes(
      repoDir,
      input.remote,
      orphans.map((ref) => ref.sha),
    )
    const now = input.now.getTime()
    const stale = refs.filter((ref) => {
      const state = ref.target ? states.get(ref.target.runId) : undefined
      if (!state) return now - (commitTimes.get(ref.sha) ?? now) > DAY_MS
      if (state.unfinished) return false
      if (!state.shadow) return true
      return !state.finishedAt || now - state.finishedAt.getTime() > 7 * DAY_MS
    })
    if (!stale.length) return { deleted: [], skipped: [] }
    const pushRemote = (await input.pushRemote?.()) ?? input.remote
    return deleteRefs(repoDir, pushRemote, stale)
  })
}

type ListedRef = { name: string; sha: string; target: IngestRefTarget | null }

async function listIngestRefs(
  repoDir: string,
  remote: IngestRemote,
): Promise<ListedRef[]> {
  const out = await runGit(
    repoDir,
    ["ls-remote", "--", remote.url, `${INGEST_REF_ROOT}*`],
    { env: remote.env },
  )
  return out
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [sha = "", name = ""] = line.split("\t")
      if (!name.startsWith(INGEST_REF_ROOT) || !sha) return []
      return [{ name, sha, target: parseIngestRef(name) }]
    })
}

/**
 * Deletes each ref with a lease on its listed tip. A ref that moved since the
 * listing is skipped, not deleted, and does not stop the other deletes.
 */
async function deleteRefs(
  repoDir: string,
  remote: IngestRemote,
  refs: ListedRef[],
): Promise<{ deleted: string[]; skipped: string[] }> {
  const deleted: string[] = []
  const skipped: string[] = []
  for (const ref of refs) {
    try {
      await runGit(
        repoDir,
        [
          "push",
          "--porcelain",
          `--force-with-lease=${ref.name}:${ref.sha}`,
          "--",
          remote.url,
          `:${ref.name}`,
        ],
        { env: remote.env },
      )
      deleted.push(ref.name)
    } catch (error) {
      const tip = await remoteTip(repoDir, remote, ref.name)
      if (tip === null) deleted.push(ref.name)
      else if (tip !== ref.sha) skipped.push(ref.name)
      else throw error
    }
  }
  return { deleted, skipped }
}

/**
 * Pushes `sha` to `ref` only when the remote ref is at `oldTip` (absent for
 * null). `sha` has `oldTip` as a parent, so the push is a fast-forward. When
 * the ref is already at `sha` (a replay), nothing changes.
 */
async function pushWithLease(
  repoDir: string,
  remote: IngestRemote,
  ref: string,
  oldTip: string | null,
  sha: string,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runGit(
        repoDir,
        [
          "push",
          "--porcelain",
          `--force-with-lease=${ref}:${oldTip ?? ""}`,
          "--",
          remote.url,
          `${sha}:${ref}`,
        ],
        { env: remote.env },
      )
      return
    } catch (error) {
      const tip = await remoteTip(repoDir, remote, ref)
      if (tip === sha) return
      if (tip !== oldTip) throw new IngestRefMovedError()
      // The ref did not move: a rival push held the ref lock, or the remote
      // failed. Try again; the lease still guards the ref.
      if (attempt >= PUSH_ATTEMPTS) throw error
      await sleep(100 * attempt)
    }
  }
}

async function remoteTip(
  repoDir: string,
  remote: IngestRemote,
  ref: string,
): Promise<string | null> {
  const out = await runGit(repoDir, ["ls-remote", "--", remote.url, ref], {
    env: remote.env,
  })
  for (const line of out.toString().split("\n")) {
    const [sha, name] = line.split("\t")
    if (name === ref && sha) return sha
  }
  return null
}

async function fetchCommits(
  repoDir: string,
  remote: IngestRemote,
  shas: string[],
  options: { blobs: boolean },
): Promise<void> {
  await runGit(
    repoDir,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      ...(options.blobs ? [] : ["--filter=tree:0"]),
      "--",
      remote.url,
      ...shas,
    ],
    { env: remote.env },
  )
}

async function tipTimes(
  repoDir: string,
  remote: IngestRemote,
  shas: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(shas)]
  if (!unique.length) return new Map()
  await fetchCommits(repoDir, remote, unique, { blobs: false })
  const out = await runGit(repoDir, [
    "log",
    "--no-walk",
    "--format=%H %ct",
    ...unique,
  ])
  return new Map(
    out
      .toString()
      .trim()
      .split("\n")
      .map((line) => {
        const [sha = "", time = "0"] = line.split(" ")
        return [sha, Number(time) * 1000] as const
      }),
  )
}

/** Changed paths from `from` to `to`, as `update-index -z --index-info` lines. */
/** One path that two shards change, as the semantic merge gets it. */
export type IngestMergeConflict = {
  path: string
  base: string | null
  current: string | null
  incoming: string | null
}

export type IngestConflictResolver = (
  conflicts: IngestMergeConflict[],
) => Promise<Array<{ path: string; content: string | null }>>

/**
 * Resolve the paths that more than one shard changes, one round for each
 * further version: round `n` merges version `n` into the result so far.
 * Then the patch validator checks the merged files as one step on `tree`
 * (the pinned revision plus the other shards' ops): a model wrote them, so
 * they get the same checks as a step's files. The host fields go back to
 * their pinned values first, and the validator stamps them again. Returns
 * the validated tree and the rejections. A rejected file keeps its version
 * on `tree`; the caller decides whether a rejection refuses the job or
 * withholds the file.
 */
async function mergeConflicts(
  repoDir: string,
  input: {
    pinnedRevision: string
    tree: string
    conflicts: Array<{ path: string; versions: Array<string | null> }>
    opsBefore: number
    bundle: string
    merge: NonNullable<
      Parameters<typeof pushIngestAssemble>[0]["semanticMerge"]
    >
    rootPath: string
  },
): Promise<{ tree: string; rejections: PatchRejection[] }> {
  const text = async (spec: string | null) =>
    spec === null
      ? null
      : (await runGit(repoDir, ["cat-file", "blob", spec])).toString("utf8")
  const current = new Map<string, string | null>()
  const base = new Map<string, string | null>()
  for (const conflict of input.conflicts) {
    current.set(conflict.path, await text(conflict.versions[0] ?? null))
    base.set(
      conflict.path,
      await text(`${input.pinnedRevision}:${conflict.path}`).catch(() => null),
    )
  }
  for (let round = 1; ; round++) {
    const open = input.conflicts.filter((c) => c.versions.length > round)
    if (!open.length) break
    const asked: IngestMergeConflict[] = []
    for (const conflict of open)
      asked.push({
        path: conflict.path,
        base: base.get(conflict.path) ?? null,
        current: current.get(conflict.path) ?? null,
        incoming: await text(conflict.versions[round] ?? null),
      })
    const resolved = await input.merge.resolve(asked)
    const paths = new Set(resolved.map((file) => file.path))
    if (
      resolved.length !== asked.length ||
      paths.size !== asked.length ||
      asked.some((conflict) => !paths.has(conflict.path))
    )
      throw new IngestRefRefusedError(
        "The semantic merge did not resolve exactly the conflicting paths",
        ["merge_paths"],
      )
    for (const file of resolved) current.set(file.path, file.content)
  }

  // The host stamped the root of each package unit in its shard step. The
  // merged file keeps it: the validator gets the unit's root, so the files
  // of one root go through one validation.
  const rootOf = async (conflict: { versions: Array<string | null> }) => {
    for (const version of conflict.versions) {
      const front = splitFrontMatter((await text(version)) ?? "")
      const root = front ? parseYamlObject(front.yaml)?.root : undefined
      if (typeof root === "string") return root
    }
    return undefined
  }
  const groups = new Map<string | undefined, typeof input.conflicts>()
  for (const conflict of input.conflicts) {
    const root = await rootOf(conflict)
    groups.set(root, [...(groups.get(root) ?? []), conflict])
  }
  let tree = input.tree
  let opsBefore = input.opsBefore
  const rejections: PatchRejection[] = []
  for (const [root, conflicts] of groups) {
    const baseCommit = (
      await runGit(
        repoDir,
        ["commit-tree", "--no-gpg-sign", tree, "-p", input.pinnedRevision],
        {
          input: "semantic merge base\n",
          env: {
            GIT_AUTHOR_NAME: STEP_AUTHOR.name,
            GIT_AUTHOR_EMAIL: STEP_AUTHOR.email,
            GIT_COMMITTER_NAME: STEP_AUTHOR.name,
            GIT_COMMITTER_EMAIL: STEP_AUTHOR.email,
          },
        },
      )
    )
      .toString()
      .trim()
    const stagedDir = await mkdtemp(join(tmpdir(), "ctxpipe-merge-"))
    try {
      const ops: Array<{ op: string; path: string; baseBlob?: string }> = []
      for (const conflict of conflicts) {
        // The validator takes paths relative to the Workspace root folder.
        const path = workspaceRelativePath(input.rootPath, conflict.path) ?? ""
        const baseBlob = await runGit(repoDir, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${baseCommit}:${conflict.path}`,
        ]).then(
          (out) => out.toString().trim(),
          () => undefined,
        )
        const content = current.get(conflict.path) ?? null
        if (content === null) {
          // A path that is not in the base tree is already absent.
          if (baseBlob) ops.push({ op: "delete", path, baseBlob })
          continue
        }
        ops.push({
          op: baseBlob ? "update" : "create",
          path,
          ...(baseBlob ? { baseBlob } : {}),
        })
        const file = join(stagedDir, "files", path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(
          file,
          withPinnedHostFields(content, base.get(conflict.path) ?? null),
        )
      }
      await writeFile(join(stagedDir, "patch.json"), JSON.stringify({ ops }))
      const result = await validatePatchStep({
        repoDir,
        baseCommit,
        stagedDir,
        source: input.merge.source,
        sourcePath: input.merge.sourcePath,
        sourcePathExists: input.merge.sourcePathExists,
        readSourceFile: input.merge.readSourceFile,
        skill: "semantic-merge",
        bundle: input.bundle,
        workspaceOpsBefore: opsBefore,
        rootPath: input.rootPath,
        ...(root === undefined ? {} : { root }),
      })
      rejections.push(...result.rejections)
      tree = result.tree
      opsBefore += ops.length
    } finally {
      await rm(stagedDir, { recursive: true, force: true })
    }
  }
  return { tree, rejections }
}

/** The fields that only the host sets (patch validator, concept section 4.3). */
const HOST_FIELDS = [
  "generated_by",
  "sources",
  "root",
  "source_sha",
  "skill",
  "bundle",
] as const

/**
 * The shard versions carry host fields that the validator stamped. Put back
 * the pinned values (or remove the field), so the validator checks the
 * merged file as a new write and stamps it again.
 */
function withPinnedHostFields(content: string, pinned: string | null): string {
  const front = splitFrontMatter(content)
  const attributes = front ? parseYamlObject(front.yaml) : null
  if (!front || !attributes) return content
  const pinnedFront = pinned ? splitFrontMatter(pinned) : null
  const pinnedAttributes =
    (pinnedFront ? parseYamlObject(pinnedFront.yaml) : null) ?? {}
  for (const field of HOST_FIELDS) {
    if (field in pinnedAttributes) attributes[field] = pinnedAttributes[field]
    else delete attributes[field]
  }
  return `---\n${stringify(attributes, { lineWidth: 0 })}---\n${front.body}`
}

async function diffTree(
  repoDir: string,
  from: string,
  to: string,
): Promise<
  Array<{
    path: string
    indexLine: string
    blob: string | null
    regularFile: boolean
  }>
> {
  const out = (
    await runGit(repoDir, ["diff-tree", "-r", "-z", "--no-renames", from, to])
  ).toString()
  const fields = out.split("\0")
  const changes: Array<{
    path: string
    indexLine: string
    blob: string | null
    regularFile: boolean
  }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? ""
    const path = fields[i + 1] ?? ""
    // ":<old mode> <new mode> <old sha> <new sha> <status>"
    const [, newMode = "", , newSha = "", status = ""] = meta
      .slice(1)
      .split(" ")
    changes.push({
      path,
      blob: status === "D" ? null : newSha,
      // A delete has mode 000000; a symlink (120000) or a submodule
      // (160000) can point outside the Workspace root folder.
      regularFile: status === "D" || newMode === "100644",
      indexLine:
        status === "D"
          ? `0 ${"0".repeat(newSha.length)}\t${path}\0`
          : `${newMode} ${newSha}\t${path}\0`,
    })
  }
  return changes
}

async function commitStep(
  repoDir: string,
  input: IngestStepCommit & {
    tree: string
    parents: string[]
    runId: string
    rejects?: number
  },
): Promise<string> {
  for (const value of [input.runId, input.step, input.bundle])
    if (!/^[\x21-\x7e]{1,200}$/.test(value))
      throw new Error("A step trailer value must be printable ASCII")
  const date = `@${Math.floor(input.authorTime.getTime() / 1000)} +0000`
  // `Ctxpipe-More` only when true, so a step with no next page keeps its SHA.
  const message = `Ingest step ${input.step}\n\nCtxpipe-Run: ${input.runId}\nCtxpipe-Step: ${input.step}\nCtxpipe-Bundle: ${input.bundle}\n${input.more ? "Ctxpipe-More: true\n" : ""}${input.rejects ? `Ctxpipe-Rejects: ${input.rejects}\n` : ""}`
  const out = await runGit(
    repoDir,
    [
      "commit-tree",
      "--no-gpg-sign",
      input.tree,
      ...input.parents.flatMap((parent) => ["-p", parent]),
    ],
    {
      input: message,
      env: {
        GIT_AUTHOR_NAME: STEP_AUTHOR.name,
        GIT_AUTHOR_EMAIL: STEP_AUTHOR.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: STEP_AUTHOR.name,
        GIT_COMMITTER_EMAIL: STEP_AUTHOR.email,
        GIT_COMMITTER_DATE: date,
      },
    },
  )
  return out.toString().trim()
}

async function stepTrailers(
  repoDir: string,
  sha: string,
): Promise<{ run: string; step: string; more: boolean; rejects: number }> {
  const read = async (key: string) =>
    (
      await runGit(repoDir, [
        "log",
        "-1",
        `--format=%(trailers:key=${key},valueonly,unfold)`,
        sha,
      ])
    )
      .toString()
      .trim()
  return {
    run: await read("Ctxpipe-Run"),
    step: await read("Ctxpipe-Step"),
    more: (await read("Ctxpipe-More")) === "true",
    rejects: Number(await read("Ctxpipe-Rejects")) || 0,
  }
}

async function withScratchRepository<T>(
  fn: (repoDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-ref-"))
  try {
    await runGit(dir, ["init", "--quiet", "--bare"])
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
