import type { Env } from "../../config/env.js"
import {
  getOrgFirstWorkspace,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import { readGitPackFromRemote } from "../../services/git/pack.js"
import type { WorkspaceExtraction } from "./extraction.js"
import { captureExtractionSourceDeclaration } from "./extraction-source.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Bind the destination before extraction; no content projection is consulted. */
export async function captureRepositoryExtractionTarget(input: {
  orgId: string
  repositoryUrl: string
  env: Env
}) {
  const workspaces = await listOrgWorkspaces(input.orgId)
  const sourceUrl = normalizeWorkspaceRepositoryUrl(input.repositoryUrl)
  const own = workspaces.find(
    (row) =>
      normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl) === sourceUrl,
  )
  const first = own ? null : await getOrgFirstWorkspace(input.orgId)
  const workspace =
    own ?? workspaces.find((row) => row.id === first?.workspaceId)
  if (!workspace) return null
  const resolved = await resolveWorkspaceReadRevision({
    orgId: input.orgId,
    workspaceId: workspace.id,
    env: input.env,
    refresh: true,
  })
  if (!resolved)
    throw new Error("Extraction destination has no committed revision")
  let sourceDeclaration: WorkspaceExtraction["sourceDeclaration"]
  if (!own) {
    const pack = await readGitPackFromRemote({
      url: resolved.revision.remote.url,
      sha: resolved.revision.sha,
      token: resolved.token,
    })
    const declaration = await captureExtractionSourceDeclaration(
      pack,
      sourceUrl,
    )
    if (!declaration) return null
    sourceDeclaration = declaration
  }
  return {
    workspaceId: workspace.id,
    sourceDeclaration,
    revision: { ...resolved.revision, access: "write-default" as const },
  }
}
