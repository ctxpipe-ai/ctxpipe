import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
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

export const INGEST_REF_ROOT = "refs/ctxpipe/ingest/"

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DAY_MS = 24 * 60 * 60 * 1000
const STALE_MS = DAY_MS
const SHADOW_STALE_MS = 7 * DAY_MS
const STEP_AUTHOR = { name: "ctxpipe", email: "ingest@ctxpipe.ai" }

export type IngestRefTarget = {
  runId: string
  workspaceId: string
  shard?: string
}

/** A remote and the git environment (credentials) to reach it. */
export type IngestRemote = { url: string; env?: NodeJS.ProcessEnv }

/** The broker refused the push. Do not retry the same job. */
export class IngestRefRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IngestRefRefusedError"
  }
}

export function ingestRefName(target: IngestRefTarget): string {
  const segments = [target.runId, target.workspaceId, target.shard ?? ""]
  if (
    !SEGMENT.test(target.runId) ||
    !SEGMENT.test(target.workspaceId) ||
    (target.shard !== undefined && !SEGMENT.test(target.shard))
  )
    throw new Error(`Unsafe ingest ref segment: ${segments.join("/")}`)
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
  /** From the run input, so that a replay makes the same SHA. */
  authorTime: Date
}

export type PushIngestStepInput = {
  /** The run and the Workspace of the job. The ref must belong to both. */
  job: { runId: string; workspaceId: string }
  ref: string
  /** The ref tip that the job expects; null when the ref must not exist. */
  oldTip: string | null
  /** The base of the first commit on a ref. */
  pinnedRevision: string
  remote: IngestRemote
  commit: IngestStepCommit
  patch: Omit<PatchStepInput, "repoDir" | "baseCommit" | "bundle">
}

/**
 * The ref job: validate the staged step against the base commit, commit the
 * accepted tree with fixed author data and trailers, and push it only when the
 * remote ref is at the expected old tip. A replay of a pushed step returns the
 * same SHA and pushes nothing.
 */
export async function pushIngestStep(
  input: PushIngestStepInput,
): Promise<{ sha: string; validation: PatchStepResult }> {
  const target = parseIngestRef(input.ref)
  if (
    !target ||
    target.runId !== input.job.runId ||
    target.workspaceId !== input.job.workspaceId
  )
    throw new IngestRefRefusedError(
      "The ref is not an ingest ref of the job's run and Workspace",
    )
  return withScratchRepository(async (repoDir) => {
    const current = await remoteTip(repoDir, input.remote, input.ref)
    if (current === null && input.oldTip !== null)
      throw new IngestRefRefusedError("The ref does not exist")
    const base = input.oldTip ?? input.pinnedRevision
    await fetchCommits(repoDir, input.remote, [base], { blobs: true })
    const validation = await validatePatchStep({
      ...input.patch,
      repoDir,
      baseCommit: base,
      bundle: input.commit.bundle,
    })
    const sha = await commitStep(repoDir, {
      tree: validation.tree,
      parent: base,
      runId: input.job.runId,
      ...input.commit,
    })
    if (current === sha) return { sha, validation }
    if (current !== input.oldTip)
      throw new IngestRefRefusedError("The ref is not at the expected old tip")
    try {
      await runGit(
        repoDir,
        [
          "push",
          "--porcelain",
          `--force-with-lease=${input.ref}:${input.oldTip ?? ""}`,
          "--",
          input.remote.url,
          `${sha}:${input.ref}`,
        ],
        { env: input.remote.env },
      )
    } catch (error) {
      // A rival push won the race. The lease refused this one.
      const after = await remoteTip(repoDir, input.remote, input.ref)
      if (after === sha) return { sha, validation }
      if (after !== input.oldTip)
        throw new IngestRefRefusedError(
          "The ref moved away from the expected old tip",
        )
      throw error
    }
    return { sha, validation }
  })
}

/**
 * Resume: the commit on the ref tip when it is this run's commit for `step`
 * (a crash after the push), else null.
 */
export async function findStepCommit(input: {
  remote: IngestRemote
  ref: string
  runId: string
  step: string
}): Promise<string | null> {
  return withScratchRepository(async (repoDir) => {
    const tip = await remoteTip(repoDir, input.remote, input.ref)
    if (!tip) return null
    await fetchCommits(repoDir, input.remote, [tip], { blobs: false })
    const trailers = await stepTrailers(repoDir, tip)
    return trailers.run === input.runId && trailers.step === input.step
      ? tip
      : null
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
    await deleteRefs(repoDir, input.remote, refs)
    return refs.map((ref) => ref.name)
  })
}

/**
 * Stale-ref clean-up for the Workspace tip check (concept section 7.4). It
 * deletes the refs of a run that is not unfinished and every ref older than
 * 24 hours. In shadow mode, refs stay 7 days for the comparison. The age is
 * the commit time of the tip, which is the run's author time.
 */
export async function cleanUpIngestRefs(input: {
  remote: IngestRemote
  now: Date
  shadow: boolean
  unfinishedRunIds: (runIds: string[]) => Promise<Set<string>>
}): Promise<{ deleted: string[] }> {
  return withScratchRepository(async (repoDir) => {
    const refs = await listIngestRefs(repoDir, input.remote)
    if (!refs.length) return { deleted: [] }
    const shas = [...new Set(refs.map((ref) => ref.sha))]
    await fetchCommits(repoDir, input.remote, shas, { blobs: false })
    const times = new Map(
      (await runGit(repoDir, ["log", "--no-walk", "--format=%H %ct", ...shas]))
        .toString()
        .trim()
        .split("\n")
        .map((line) => {
          const [sha = "", time = "0"] = line.split(" ")
          return [sha, Number(time) * 1000] as const
        }),
    )
    const runIds = [
      ...new Set(refs.flatMap((ref) => (ref.target ? [ref.target.runId] : []))),
    ]
    const unfinished = input.shadow
      ? new Set<string>()
      : await input.unfinishedRunIds(runIds)
    const stale = refs.filter((ref) => {
      const age = input.now.getTime() - (times.get(ref.sha) ?? 0)
      if (!ref.target) return age > STALE_MS
      if (input.shadow) return age > SHADOW_STALE_MS
      return !unfinished.has(ref.target.runId) || age > STALE_MS
    })
    await deleteRefs(repoDir, input.remote, stale)
    return { deleted: stale.map((ref) => ref.name) }
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

async function deleteRefs(
  repoDir: string,
  remote: IngestRemote,
  refs: ListedRef[],
): Promise<void> {
  if (!refs.length) return
  // The lease deletes a ref only at the listed tip, so a ref that a step
  // advanced in the meantime stays.
  await runGit(
    repoDir,
    [
      "push",
      "--porcelain",
      ...refs.map((ref) => `--force-with-lease=${ref.name}:${ref.sha}`),
      "--",
      remote.url,
      ...refs.map((ref) => `:${ref.name}`),
    ],
    { env: remote.env },
  )
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

async function commitStep(
  repoDir: string,
  input: IngestStepCommit & { tree: string; parent: string; runId: string },
): Promise<string> {
  for (const value of [input.runId, input.step, input.bundle])
    if (!/^[\x21-\x7e]{1,200}$/.test(value))
      throw new Error("A step trailer value must be printable ASCII")
  const date = `@${Math.floor(input.authorTime.getTime() / 1000)} +0000`
  const message = `Ingest step ${input.step}\n\nCtxpipe-Run: ${input.runId}\nCtxpipe-Step: ${input.step}\nCtxpipe-Bundle: ${input.bundle}\n`
  const out = await runGit(
    repoDir,
    ["commit-tree", "--no-gpg-sign", input.tree, "-p", input.parent],
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
): Promise<{ run: string; step: string }> {
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
  return { run: await read("Ctxpipe-Run"), step: await read("Ctxpipe-Step") }
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
