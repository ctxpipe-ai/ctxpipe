import { requireCurrentOrgId } from "../../auth/context.js"
import { findRepositoriesByNormalizedGitUrls } from "../../models/repositories.js"
import {
  CodesearchCheckoutError,
  fetchCheckoutFileBytes,
  globCheckoutFiles,
} from "../codeIngestion/codesearchClient.js"
import type { ExplorerGitFile } from "./git-explorer.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export class WorkspaceCheckoutReadError extends Error {
  override readonly name = "WorkspaceCheckoutReadError"

  constructor(
    message: string,
    readonly status: 404 | 409 | 502,
  ) {
    super(message)
  }
}

async function resolveWorkspaceRepository(gitUrl: string): Promise<{
  id: string
} | null> {
  const url = normalizeWorkspaceRepositoryUrl(gitUrl)
  if (!url) return null
  const rows = await findRepositoriesByNormalizedGitUrls([url])
  return rows[0] ?? null
}

function mapCodesearchError(error: unknown): WorkspaceCheckoutReadError {
  if (error instanceof WorkspaceCheckoutReadError) return error
  const status = error instanceof CodesearchCheckoutError ? error.status : 502
  if (status === 404 || status === 409) {
    return new WorkspaceCheckoutReadError(
      "This Workspace checkout is not ready yet.",
      409,
    )
  }
  return new WorkspaceCheckoutReadError(
    "Could not read this Workspace repository.",
    502,
  )
}

export async function listWorkspaceCheckoutPaths(input: {
  workspaceId: string
  gitUrl: string
}): Promise<string[]> {
  const repo = await resolveWorkspaceRepository(input.gitUrl)
  if (!repo) {
    throw new WorkspaceCheckoutReadError(
      "This Workspace checkout is not ready yet.",
      409,
    )
  }
  try {
    const globbed = await globCheckoutFiles({
      repositoryId: repo.id,
      orgId: requireCurrentOrgId(),
      workspaceId: input.workspaceId,
    })
    return globbed.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path)
  } catch (error) {
    throw mapCodesearchError(error)
  }
}

export async function readWorkspaceCheckoutFile(input: {
  workspaceId: string
  gitUrl: string
  path: string
}): Promise<ExplorerGitFile> {
  const repo = await resolveWorkspaceRepository(input.gitUrl)
  if (!repo) {
    throw new WorkspaceCheckoutReadError(
      "This Workspace checkout is not ready yet.",
      409,
    )
  }
  try {
    const bytes = await fetchCheckoutFileBytes({
      repositoryId: repo.id,
      orgId: requireCurrentOrgId(),
      workspaceId: input.workspaceId,
      path: input.path,
    })
    if (!bytes) return { kind: "missing" }
    return { kind: "bytes", bytes }
  } catch (error) {
    throw mapCodesearchError(error)
  }
}
