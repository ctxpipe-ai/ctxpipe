import { assertRepositoryIngestionRequest } from "../../models/repository-ingestion-requests.js"
import {
  type GitPack,
  nativeGit,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import type { WorkspaceExtraction } from "./extraction.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
  parseSimpleFrontMatter,
} from "./layout.js"
import type { WorkspaceRevision } from "./revision.js"
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
    const [before] = await readGitFiles(base, (path) => path === expected.path)
    const [after] = await readGitFiles(pack, (path) => path === expected.path)
    if (!before || !after)
      throw new Error("Extraction cannot remove its source declaration")
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
}

import { isDeepStrictEqual } from "node:util"
