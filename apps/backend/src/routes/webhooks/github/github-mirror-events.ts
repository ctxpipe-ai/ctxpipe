import { parseEnv } from "../../../config/env.js"
import { normalizeWorkspaceRepositoryUrl } from "../../../domain/workspaces/slug.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { listGithubPrMirrorWorkspaceIds } from "../../../models/github-pr-mirror.js"

/**
 * Start one mirror job per Workspace that links the repository; none when no
 * Workspace does. A failed enqueue throws so the delivery answers 5xx and
 * GitHub's redelivery retries; the idempotency key skips jobs already started.
 */
export async function enqueueForLinkingWorkspaces(
  input: {
    installationId: number
    githubConnectionId?: string
    repositoryFullName: string
  },
  start: (target: {
    orgId: string
    workspaceId: string
    gitUrl: string
    connectionId: string
  }) => Promise<unknown>,
): Promise<void> {
  const gitUrl = normalizeWorkspaceRepositoryUrl(
    `https://github.com/${input.repositoryFullName}`,
  )
  const installations = await listInstallationsByGithubInstallationId(
    input.installationId,
    input.githubConnectionId,
    parseEnv(process.env as Record<string, string | undefined>),
  )
  const failures: unknown[] = []
  for (const installation of installations) {
    const workspaceIds = await listGithubPrMirrorWorkspaceIds({
      orgId: installation.orgId,
      gitUrl,
    })
    for (const workspaceId of workspaceIds)
      await start({
        orgId: installation.orgId,
        workspaceId,
        gitUrl,
        connectionId: installation.id,
      }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length)
    throw new AggregateError(failures, "GitHub mirror could not be enqueued")
}
