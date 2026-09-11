import { requireCurrentOrgId } from "../../auth/context.js"
import {
  fetchCheckoutFileBytes,
  listCheckoutTree,
} from "../codeIngestion/codesearchClient.js"
import type { ExplorerGitFile } from "./git-explorer.js"

export type WorkspaceCheckoutRead = {
  workspaceId: string
  repositoryId: string
  sha: string
}

export async function listWorkspaceCheckoutPaths(
  input: WorkspaceCheckoutRead,
): Promise<string[]> {
  return (
    await listCheckoutTree({ ...input, orgId: requireCurrentOrgId() })
  ).sort()
}

export async function readWorkspaceCheckoutFile(
  input: WorkspaceCheckoutRead & { path: string },
): Promise<ExplorerGitFile> {
  const bytes = await fetchCheckoutFileBytes({
    ...input,
    orgId: requireCurrentOrgId(),
  })
  return bytes === null ? { kind: "missing" } : { kind: "bytes", bytes }
}
