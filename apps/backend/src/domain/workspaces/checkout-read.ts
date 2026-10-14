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
  const bytes = await fetchCheckoutFileBytes({
    ...input,
    path: workspaceRepositoryPath(input.rootPath, input.path),
    orgId: requireCurrentOrgId(),
  })
  return bytes === null ? { kind: "missing" } : { kind: "bytes", bytes }
}
