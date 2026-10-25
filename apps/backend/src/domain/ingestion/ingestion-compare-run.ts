import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ShadowRunPair } from "../../models/ingestion-shadow-runs.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import type { IngestRemote } from "./ingest-refs.js"
import {
  compareWorkspace,
  type ExtractedProjection,
  type IngestionLabelSet,
  type InjectionPayload,
  labelCoverage,
  OLD_GENERATED_BY,
  projectExtractedTree,
  type RunComparison,
} from "./ingestion-compare.js"
import { ingestionV2InputSchema } from "./ingestion-run.js"
import { runGit } from "./run-git.js"

/** A Markdown file above this size is not read: no extracted file is that large. */
const MAX_MARKDOWN_BYTES = 1024 * 1024

/**
 * The Markdown files of one revision of a remote, read in a new scratch
 * repository. `revision` is a commit SHA or `HEAD` (the default branch).
 */
export async function readMarkdownTree(
  remote: IngestRemote,
  revision: string,
): Promise<{
  commit: string
  files: Array<{ path: string; content: string }>
}> {
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-compare-"))
  try {
    await runGit(dir, ["init", "--quiet", "--bare"])
    await runGit(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "--",
        remote.url,
        revision,
      ],
      { env: remote.env },
    )
    const commit = (await runGit(dir, ["rev-parse", "FETCH_HEAD^{commit}"]))
      .toString("utf8")
      .trim()
    const entries = (await runGit(dir, ["ls-tree", "-r", "-z", "-l", commit]))
      .toString("utf8")
      .split("\0")
      .flatMap((line) => {
        const tab = line.indexOf("\t")
        if (tab === -1) return []
        const [, type = "", sha = "", size = ""] = line
          .slice(0, tab)
          .split(/\s+/)
        const path = line.slice(tab + 1)
        return type === "blob" &&
          path.endsWith(".md") &&
          Number(size) <= MAX_MARKDOWN_BYTES
          ? [{ path, sha }]
          : []
      })
    if (!entries.length) return { commit, files: [] }
    const out = await runGit(dir, ["cat-file", "--batch"], {
      input: `${entries.map((e) => e.sha).join("\n")}\n`,
    })
    const files: Array<{ path: string; content: string }> = []
    let at = 0
    for (const entry of entries) {
      const newline = out.indexOf(0x0a, at)
      const size = Number(
        out.subarray(at, newline).toString("utf8").split(" ")[2],
      )
      const start = newline + 1
      files.push({
        path: entry.path,
        content: out.subarray(start, start + size).toString("utf8"),
      })
      at = start + size + 1
    }
    return { commit, files }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type ShadowWorkspaceOutput = {
  workspaceId: string
  assembled: string | null
  ops: number
  rejects: number
  partial: number
  refused?: string
}

function shadowWorkspaces(output: unknown): {
  status: string
  workspaces: ShadowWorkspaceOutput[]
} {
  const value = (output ?? {}) as {
    status?: unknown
    workspaces?: unknown
  }
  const status = typeof value.status === "string" ? value.status : "unknown"
  const workspaces = Array.isArray(value.workspaces)
    ? (value.workspaces as ShadowWorkspaceOutput[]).filter(
        (w) => w && typeof w.workspaceId === "string",
      )
    : []
  return { status, workspaces }
}

const duration = (start: Date | null, end: Date | null) =>
  start && end ? end.getTime() - start.getTime() : null

/** Immutable commits for one run and destination Workspace. */
export type ComparisonRevisions = Record<
  string,
  {
    oldPublished?: string
    shadowBase?: string
  }
>

/** Compare the old published tree with the files changed by the shadow run. */
export async function compareShadowRun(input: {
  pair: ShadowRunPair
  remoteFor: (workspaceId: string) => Promise<IngestRemote>
  revisions?: ComparisonRevisions
  labels?: readonly IngestionLabelSet[]
  injectionPayloads?: readonly InjectionPayload[]
  costUsd?: { old: number | null; shadow: number | null }
}): Promise<RunComparison> {
  const parsed = ingestionV2InputSchema.safeParse(input.pair.input)
  if (!parsed.success)
    throw new Error(
      `The shadow run ${input.pair.shadowRunId} has no valid ingestion v2 input`,
    )
  const sourceUrl = parsed.data.source.url
  const { status, workspaces } = shadowWorkspaces(input.pair.output)
  const olds: ExtractedProjection[] = []
  const shadows: ExtractedProjection[] = []
  const compared: RunComparison["workspaces"] = []
  const revisionGaps: NonNullable<RunComparison["revisionGaps"]> = []
  for (const workspace of workspaces) {
    const stored = input.pair.revisions?.[workspace.workspaceId]
    const manual = input.revisions?.[workspace.workspaceId]
    const revisions = {
      oldPublished: stored?.oldPublished ?? manual?.oldPublished,
      shadowBase: stored?.shadowBase ?? manual?.shadowBase,
    }
    for (const field of ["oldPublished", "shadowBase"] as const)
      if (!stored?.[field])
        revisionGaps.push({
          workspaceId: workspace.workspaceId,
          field,
          resolvedByOverride: Boolean(manual?.[field]),
        })
    if (!revisions.oldPublished || !revisions.shadowBase) continue
    const remote = await input.remoteFor(workspace.workspaceId)
    for (const revision of [revisions.oldPublished, revisions.shadowBase])
      if (!/^[0-9a-f]{40}$/.test(revision))
        throw new Error("Comparison revisions must be commit SHAs")
    const oldTree = await readMarkdownTree(remote, revisions.oldPublished)
    const old = projectExtractedTree({
      files: oldTree.files,
      generatedBy: OLD_GENERATED_BY,
      sourceUrl,
    })
    let shadow: ExtractedProjection = { units: [] }
    if (workspace.assembled) {
      const base = await readMarkdownTree(remote, revisions.shadowBase)
      const tip = await readMarkdownTree(remote, workspace.assembled)
      const before = new Map(
        base.files.map((file) => [file.path, file.content]),
      )
      const changed = new Set(
        tip.files
          .filter((file) => before.get(file.path) !== file.content)
          .map((file) => file.path),
      )
      shadow = projectExtractedTree({ files: tip.files, changedPaths: changed })
    }
    olds.push(old)
    shadows.push(shadow)
    compared.push(
      compareWorkspace({
        workspaceId: workspace.workspaceId,
        oldCommit: oldTree.commit,
        shadowTip: workspace.assembled,
        old,
        shadow,
        run: {
          ops: workspace.ops ?? 0,
          rejects: workspace.rejects ?? 0,
          partial: workspace.partial ?? 0,
          ...(workspace.refused ? { refused: workspace.refused } : {}),
        },
        injectionPayloads: input.injectionPayloads,
      }),
    )
  }
  const source = normalizeWorkspaceRepositoryUrl(sourceUrl)
  const labels = input.labels?.find(
    (set) => normalizeWorkspaceRepositoryUrl(set.sourceUrl) === source,
  )
  return {
    shadowRunId: input.pair.shadowRunId,
    oldRunId: input.pair.oldRunId,
    sourceUrl,
    sha: parsed.data.sha,
    status: revisionGaps.some((gap) => !gap.resolvedByOverride)
      ? "incomplete"
      : status,
    revisionGaps,
    durationMs: {
      old: duration(input.pair.oldStartedAt, input.pair.oldFinishedAt),
      shadow: duration(input.pair.shadowStartedAt, input.pair.shadowFinishedAt),
    },
    costUsd: input.costUsd ?? { old: null, shadow: null },
    workspaces: compared,
    labels: labels ? labelCoverage(labels, olds, shadows) : null,
  }
}
