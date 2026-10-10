import {
  getGithubInstallationByConnectionId,
  resolveGithubInstallationForOrgDetailed,
} from "../../models/github-installation.js"

export const WORKSPACE_ADD_SOURCES = {
  select: "select",
  paste: "paste",
} as const

export type WorkspaceAddSource =
  (typeof WORKSPACE_ADD_SOURCES)[keyof typeof WORKSPACE_ADD_SOURCES]

/**
 * Stamp a connection only when it belongs to this org.
 * Select without an id may use the org's only GitHub connection.
 * Paste never infers a connection.
 */
export async function resolveWorkspaceGithubConnectionId(input: {
  orgId: string
  requested: string | null | undefined
  source?: WorkspaceAddSource | null
}): Promise<string | null> {
  if (input.requested) {
    const installation = await getGithubInstallationByConnectionId(
      input.orgId,
      input.requested,
    )
    return installation?.id ?? null
  }
  if (input.source === WORKSPACE_ADD_SOURCES.select) {
    const resolved = await resolveGithubInstallationForOrgDetailed(
      input.orgId,
      null,
    )
    return resolved.status === "ok" ? resolved.installation.id : null
  }
  return null
}
