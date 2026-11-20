import type { Env } from "../config/env.js"
import type { GitHubInstallationShape } from "../models/connection-rows.js"
import {
  refreshGithubConnectionAccountSlug,
  registerInstallationOnConnection,
  upsertInstallation,
} from "../models/github-installation.js"
import { getLogger } from "../observability/logger.js"
import { rebindUnboundWorkspaces } from "./workspaces/workspace-lifecycle.js"

/**
 * Attaches a proven installation to the org: to the named connection, else to
 * the org's connection for that installation. `undefined` when the named
 * connection is gone.
 */
export async function attachGithubInstallation(input: {
  orgId: string
  installationId: number
  connectionId?: string
  env: Env
}): Promise<GitHubInstallationShape | undefined> {
  const { orgId, installationId, env } = input
  let installation: GitHubInstallationShape | undefined
  if (input.connectionId) {
    installation = await registerInstallationOnConnection({
      orgId,
      connectionId: input.connectionId,
      installationId,
      env,
    })
    if (!installation) return undefined
  } else {
    installation = await upsertInstallation(orgId, installationId, env)
    installation =
      (await refreshGithubConnectionAccountSlug(orgId, installation.id, env)) ??
      installation
  }
  await rebindUnboundWorkspaces({
    orgId,
    connectionId: installation.id,
    env,
    log: getLogger(),
  })
  return installation
}
