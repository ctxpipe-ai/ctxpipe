import { requireCurrentOrgId } from "../../auth/context.js"
import { getWorkspaceSearchProjection } from "../../models/workspaces.js"
import {
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "../../services/git/root-folder.js"
import {
  fetchCheckoutFileBytes,
  fetchCheckoutFileBytesUpTo,
  listCheckoutTree,
} from "../codeIngestion/codesearchClient.js"
import type { ExplorerGitFile } from "./git-explorer.js"
import { publishedProjection } from "./revision.js"
import { workspaceRootPath } from "./root-path.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

type WorkspaceCheckoutRead = {
  workspaceId: string
  repositoryId: string
  sha: string
  /** Workspace root folder; paths in and out are relative to it. */
  rootPath: string
}

/**
 * The published checkout of the Workspace repository: the one that the
 * Files pane reads. Null until the index of the Workspace publishes.
 */
export async function publishedWorkspaceCheckout(
  workspaceId: string,
): Promise<WorkspaceCheckoutRead | null> {
  const { projection, repositories } =
    await getWorkspaceSearchProjection(workspaceId)
  const active = publishedProjection(projection)
  const published =
    active?.kind === "active" ? active.stores.index.published : null
  const repository = published
    ? repositories.find(
        (repo) =>
          repo.sha === published.sha &&
          normalizeWorkspaceRepositoryUrl(repo.gitUrl) ===
            normalizeWorkspaceRepositoryUrl(published.remote.url),
      )
    : undefined
  if (!published || !repository) return null
  return {
    workspaceId,
    repositoryId: repository.id,
    sha: published.sha,
    rootPath: workspaceRootPath(published),
  }
}

export async function listWorkspaceCheckoutPaths(
  input: WorkspaceCheckoutRead,
): Promise<string[]> {
  return (await listCheckoutTree({ ...input, orgId: requireCurrentOrgId() }))
    .flatMap((path) => workspaceRelativePath(input.rootPath, path) ?? [])
    .sort()
}

export async function readWorkspaceCheckoutFile(
  input: WorkspaceCheckoutRead & { path: string; maxBytes?: number },
): Promise<ExplorerGitFile> {
  // Refuse an unsafe path before any request.
  workspaceRepositoryPath(input.rootPath, input.path)
  // Codesearch resolves the path and its symlinks inside the root folder, so
  // a link below the root cannot read a file outside it. It does not read a
  // file larger than `maxBytes`.
  const query = {
    ...input,
    ...(input.rootPath ? { root: input.rootPath } : {}),
    orgId: requireCurrentOrgId(),
  }
  const { maxBytes } = input
  const file =
    maxBytes === undefined
      ? await fetchCheckoutFileBytes(query)
      : await fetchCheckoutFileBytesUpTo({ ...query, maxBytes })
  if (file === null) return { kind: "missing" }
  if ("tooLarge" in file) return { kind: "tooLarge", size: file.size }
  return { kind: "bytes", bytes: file }
}
