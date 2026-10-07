import { and, eq } from "drizzle-orm"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceLinkedRepositories } from "../../db/schema/workspaces.js"
import { getWorkspaceGithubReadToken } from "../../models/github-installation.js"
import {
  type AgentVaultAccess,
  AgentVaultUnavailableError,
  agentVaultAccess,
  githubRules,
  openRunVault,
  type RunVault,
} from "./agent-vault.js"
import type { WorkspaceRevision } from "./revision.js"
import { recordedRunGitToken } from "./run-git-tokens.js"

/** The `owner/name` of an exact HTTPS GitHub repository URL. */
export function workspaceChatGithubRepository(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return undefined
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      parsed.pathname,
    )
    if (
      !match?.[1] ||
      !match[2] ||
      [match[1], match[2]].some((part) => part === "." || part === "..")
    )
      return undefined
    return `${match[1]}/${match[2]}`.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The GitHub repositories a Docker run may read: the Workspace repository and
 * the linked repositories on the same GitHub connection.
 */
export async function workspaceGithubReadScope(
  orgId: string,
  revision: WorkspaceRevision,
): Promise<string[]> {
  const connectionId = revision.remote.connectionId
  if (!connectionId) return []
  const linked = await withOrgDbContext(orgId, (db) =>
    db
      .select({ url: workspaceLinkedRepositories.gitUrl })
      .from(workspaceLinkedRepositories)
      .innerJoin(
        repositories,
        and(
          eq(repositories.gitUrl, workspaceLinkedRepositories.gitUrl),
          eq(repositories.orgId, workspaceLinkedRepositories.orgId),
          eq(repositories.githubConnectionId, connectionId),
        ),
      )
      .where(
        and(
          eq(workspaceLinkedRepositories.orgId, orgId),
          eq(workspaceLinkedRepositories.workspaceId, revision.workspaceId),
        ),
      ),
  )
  return [
    ...new Set(
      [revision.remote.url, ...linked.map((entry) => entry.url)]
        .map(workspaceChatGithubRepository)
        .filter((name): name is string => !!name),
    ),
  ]
    .sort()
    .slice(0, 500)
}

/** A turn's session lasts at most this long; the sweep waits for it. */
export const RUN_VAULT_TTL_SECONDS = 2 * 60 * 60

/**
 * Open the vault of one Docker run (a turn, a prepare, or a Workspace base
 * build). It holds a GitHub read token for the Workspace's read scope,
 * recorded under `label` so the run end (or the sweep) revokes it. Throws
 * {@link AgentVaultUnavailableError} when the deployment has no Agent Vault
 * or it does not answer: Docker sandboxes never get a credential instead.
 */
export async function openDockerRunVault(input: {
  orgId: string
  conversationId: string
  label: string
  revision: WorkspaceRevision
  access?: AgentVaultAccess
}): Promise<RunVault> {
  const access = input.access ?? agentVaultAccess()
  if (!access)
    throw new AgentVaultUnavailableError(
      "Docker chat sandboxes need Agent Vault (AGENT_VAULT_ADDR is not set)",
    )
  const connectionId = input.revision.remote.connectionId
  const names = await workspaceGithubReadScope(input.orgId, input.revision)
  const token =
    connectionId && names.length > 0
      ? await recordedRunGitToken({
          orgId: input.orgId,
          conversationId: input.conversationId,
          label: input.label,
          mint: () =>
            getWorkspaceGithubReadToken(
              input.orgId,
              parseEnv(process.env as Record<string, string | undefined>),
              { githubConnectionId: connectionId, repoFullNames: names },
            ),
        })
      : undefined
  return openRunVault({
    access,
    runKey: `${input.conversationId}:${input.label}`,
    ttlSeconds: RUN_VAULT_TTL_SECONDS,
    rules: token ? githubRules(token) : [],
  })
}
