import type { Env } from "../../config/env.js"
import {
  getGithubInstallationByConnectionId,
  listGithubConnectionsForOrg,
  resolveGithubInstallationForOrgDetailed,
  resolveRepoReadCoverage,
} from "../../models/github-installation.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export const WORKSPACE_ADD_SOURCES = {
  select: "select",
  paste: "paste",
} as const

export type WorkspaceAddSource =
  (typeof WORKSPACE_ADD_SOURCES)[keyof typeof WORKSPACE_ADD_SOURCES]

/**
 * Stamp a connection only when it belongs to this org.
 * Select without an id may use the org's only GitHub connection.
 * Paste binds the first org connection whose installation covers the GitHub
 * repository (`resolveRepoReadCoverage`, the same proof as the rebind).
 * Otherwise Paste stays unbound, and a later connection or access change
 * rebinds it. A GitHub error is `unknown`, so Paste stays unbound.
 */
export async function resolveWorkspaceGithubConnectionId(input: {
  orgId: string
  requested: string | null | undefined
  source?: WorkspaceAddSource | null
  /** With `env`, lets Paste find a connection that covers this URL. */
  gitUrl?: string
  env?: Env
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
  const repoFullName = input.gitUrl
    ? githubRepoFullNameFromWorkspaceUrl(input.gitUrl)
    : null
  if (
    input.source !== WORKSPACE_ADD_SOURCES.paste ||
    !repoFullName ||
    !input.env
  )
    return null
  for (const connection of await listGithubConnectionsForOrg(input.orgId)) {
    const coverage = await resolveRepoReadCoverage(input.orgId, input.env, {
      githubConnectionId: connection.id,
      repoFullName,
    })
    if (coverage === "covers") return connection.id
  }
  return null
}
