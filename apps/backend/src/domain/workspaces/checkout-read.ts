import { requireCurrentOrgId } from "../../auth/context.js"
import {
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "../../services/git/root-folder.js"
import {
  fetchCheckoutFileBytes,
  listCheckoutTree,
} from "../codeIngestion/codesearchClient.js"
import type { ExplorerGitFile } from "./git-explorer.js"

export type WorkspaceCheckoutRead = {
  workspaceId: string
  repositoryId: string
  sha: string
  /** Workspace root folder; paths in and out are relative to it. */
  rootPath: string
}

export async function listWorkspaceCheckoutPaths(
  input: WorkspaceCheckoutRead,
): Promise<string[]> {
  return (await listCheckoutTree({ ...input, orgId: requireCurrentOrgId() }))
    .flatMap((path) => workspaceRelativePath(input.rootPath, path) ?? [])
    .sort()
}

export async function readWorkspaceCheckoutFile(
  input: WorkspaceCheckoutRead & { path: string },
): Promise<ExplorerGitFile> {
  // Refuse an unsafe path before any request.
  workspaceRepositoryPath(input.rootPath, input.path)
  // Codesearch resolves the path and its symlinks inside the root folder, so
  // a link below the root cannot read a file outside it.
  const bytes = await fetchCheckoutFileBytes({
    ...input,
    ...(input.rootPath ? { root: input.rootPath } : {}),
    orgId: requireCurrentOrgId(),
  })
  return bytes === null ? { kind: "missing" } : { kind: "bytes", bytes }
}
