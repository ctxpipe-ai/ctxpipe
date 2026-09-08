import type { Env } from "../../config/env.js"
import {
  getOrgFirstWorkspace,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import { readGitFiles, readGitPackFromRemote } from "../../services/git/pack.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
} from "./layout.js"
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
  if (!own) {
    const pack = await readGitPackFromRemote({
      url: resolved.revision.remote.url,
      sha: resolved.revision.sha,
      token: resolved.token,
    })
    const declarations = await readGitFiles(pack, isLinkedRepositoryDeclaration)
    if (
      !declarations.some((file) => {
        const declaration = parseLinkedRepositoryMarkdown(file.content)
        return (
          !declaration.malformed &&
          normalizeWorkspaceRepositoryUrl(declaration.git) === sourceUrl
        )
      })
    )
      return null
  }
  return {
    workspaceId: workspace.id,
    revision: { ...resolved.revision, access: "write-default" as const },
  }
}
