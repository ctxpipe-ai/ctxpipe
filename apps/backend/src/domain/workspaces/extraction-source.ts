import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { assertRepositoryIngestionRequest } from "../../models/repository-ingestion-requests.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import {
  type GitPack,
  nativeGit,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import { readGitCommitChanges } from "../../services/git/write-tree.js"
import { disallowedPathReason } from "../ingestion/patch-validator.js"
import type { WorkspaceExtraction } from "./extraction.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
  parseSimpleFrontMatter,
} from "./layout.js"
import { gitObjectIdSchema, type WorkspaceRevision } from "./revision.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** The first valid declaration in Git tree order is the canonical clone authority. */
export async function captureExtractionSourceDeclaration(
  pack: GitPack,
  repositoryUrl: string,
) {
  const files = await readGitFiles(pack, isLinkedRepositoryDeclaration)
  const declaration = files.find((file) => {
    const parsed = parseLinkedRepositoryMarkdown(file.content)
    return (
      !parsed.malformed &&
      normalizeWorkspaceRepositoryUrl(parsed.git) ===
        normalizeWorkspaceRepositoryUrl(repositoryUrl)
    )
  })
  if (!declaration) return null
  const blobSha = await withGitDirectory(
    pack.sha,
    async (directory) =>
      (
        await nativeGit(directory, [
          "rev-parse",
          `${pack.sha}:${declaration.path}`,
        ])
      )
        .toString()
        .trim(),
    pack,
  )
  return { path: declaration.path, blobSha }
}

/** A queued capture cannot follow a removed, edited, or replaced clone declaration. */
export async function assertExtractionSource(
  orgId: string,
  extraction: WorkspaceExtraction,
  revision: WorkspaceRevision,
  pack: GitPack,
): Promise<void> {
  await assertRepositoryIngestionRequest({
    orgId,
    repositoryId: extraction.repositoryId,
    repositoryUrl: extraction.repositoryUrl,
    requestId: extraction.ingestionRequestId,
  })
  if (
    normalizeWorkspaceRepositoryUrl(extraction.repositoryUrl) ===
    normalizeWorkspaceRepositoryUrl(revision.remote.url)
  ) {
    if (extraction.sourceDeclaration)
      throw new Error("Workspace extraction cannot use a linked declaration")
    await assertSourceClaimsOnly(revision, pack, "AGENTS.md")
    return
  }
  const expected = extraction.sourceDeclaration
  // Publication may add claims to the source document. The captured authority
  // must still match its exact blob in the parent revision, before those edits.
  const base = pack.sha === revision.sha ? pack : { ...pack, sha: revision.sha }
  const actual = expected
    ? await captureExtractionSourceDeclaration(base, extraction.repositoryUrl)
    : null
  if (
    !expected ||
    !actual ||
    actual.path !== expected.path ||
    actual.blobSha !== expected.blobSha
  )
    throw new Error("Extraction source declaration changed")
  if (pack.sha !== revision.sha) {
    const candidateDeclaration = await captureExtractionSourceDeclaration(
      pack,
      extraction.repositoryUrl,
    )
    if (candidateDeclaration?.path !== expected.path)
      throw new Error(
        "Extraction may only update claims in its source declaration",
      )
    await assertSourceClaimsOnly(revision, pack, expected.path)
  }
}

async function assertSourceClaimsOnly(
  revision: WorkspaceRevision,
  pack: GitPack,
  path: string,
): Promise<void> {
  if (pack.sha === revision.sha) return
  const base = { ...pack, sha: revision.sha }
  const [before] = await readGitFiles(base, (candidate) => candidate === path)
  const [after] = await readGitFiles(pack, (candidate) => candidate === path)
  if (!before && !after) return
  if (!before || !after)
    throw new Error("Extraction cannot remove its source declaration")
  if (before.content === after.content) return
  const original = parseSimpleFrontMatter(before.content)
  const candidate = parseSimpleFrontMatter(after.content)
  const metadata = (attributes: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(attributes).filter(([key]) => key !== "claims"),
    )
  if (
    original.malformed ||
    candidate.malformed ||
    original.body !== candidate.body ||
    !isDeepStrictEqual(
      metadata(original.attributes),
      metadata(candidate.attributes),
    )
  )
    throw new Error(
      "Extraction may only update claims in its source declaration",
    )
}

/**
 * The source of a publish from an ingestion v2 run (ADR-052 section 6, T21):
 * the run, and the tip of its assembled ref in the Workspace repository. The
 * publish replays the delta from the pinned revision (the command's revision)
 * to `tip`. `retract` is false for a `partial` Workspace: then the publish
 * keeps each file that the delta deletes, because a failed root gets no
 * retraction (concept section 7.3).
 */
export const ingestPublishSourceSchema = z
  .object({
    runId: z.string().min(1),
    tip: gitObjectIdSchema,
    retract: z.boolean(),
  })
  .strict()

export type IngestPublishSource = z.infer<typeof ingestPublishSourceSchema>

/**
 * The files of a publish, from the delta between the pinned revision and the
 * assembled tip. Each step commit passed the patch validator, so a path out
 * of the allowlist here is a defect: the publish stops and writes nothing.
 */
export function ingestPublishChanges(
  delta: { files: GitFileChange[]; deletePaths: string[] },
  retract: boolean,
): { files: GitFileChange[]; deletePaths: string[] } {
  for (const path of [
    ...delta.files.map((file) => file.path),
    ...delta.deletePaths,
  ]) {
    const reason = disallowedPathReason(path)
    if (reason) throw new Error(`The assembled ref changes ${path}: ${reason}`)
  }
  return {
    files: delta.files,
    deletePaths: retract ? delta.deletePaths : [],
  }
}

/**
 * Reads the publish delta. `pack` holds the pinned revision (`pinned`) and
 * the assembled tip. The tip must be a commit of the run (its `Ctxpipe-Run`
 * trailer), so a command cannot publish a commit of another run.
 */
export async function readIngestPublishChanges(
  pack: GitPack,
  pinned: string,
  source: IngestPublishSource,
): Promise<{ files: GitFileChange[]; deletePaths: string[] }> {
  const tipPack = { ...pack, sha: source.tip }
  const run = await withGitDirectory(
    source.tip,
    async (directory) =>
      (
        await nativeGit(directory, [
          "log",
          "-1",
          "--format=%(trailers:key=Ctxpipe-Run,valueonly,unfold)",
          source.tip,
        ])
      )
        .toString()
        .trim(),
    tipPack,
  )
  if (run !== source.runId)
    throw new Error("The assembled tip is not a commit of the ingestion run")
  return ingestPublishChanges(
    await readGitCommitChanges(tipPack, pinned),
    source.retract,
  )
}
