import { requireCurrentOrgId } from "../../auth/context.js"
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

type WorkspaceCheckoutRead = {
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
