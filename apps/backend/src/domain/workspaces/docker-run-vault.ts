import type { SandboxProvider } from "@tanstack/ai-sandbox"
import { and, eq } from "drizzle-orm"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { getWorkspaceGithubReadToken } from "../../models/github-installation.js"
import { listServedRepositoryPins } from "../../models/workspace-source-state.js"
import {
  type AgentVaultAccess,
  AgentVaultUnavailableError,
  agentVaultAccess,
  openRunVault,
  type RunVault,
} from "./agent-vault.js"
import type { WorkspaceRevision } from "./revision.js"
import { recordedRunGitToken, revokeRunGitTokens } from "./run-git-tokens.js"
import { githubCredentialRules } from "./sandbox-credential-rules.js"
import { wrapSandboxHandles } from "./sandbox-process-guards.js"

/** The `owner/name` of an exact HTTPS GitHub repository URL. */
function workspaceChatGithubRepository(url: string): string | undefined {
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
 * the served linked repositories on the same GitHub connection.
 */
export async function workspaceGithubReadScope(
  orgId: string,
  revision: WorkspaceRevision,
): Promise<string[]> {
  const connectionId = revision.remote.connectionId
  if (!connectionId) return []
  const linked = await withOrgDbContext(orgId, async (db) => {
    const [pins, bound] = await Promise.all([
      listServedRepositoryPins(db, {
        orgId,
        workspaceId: revision.workspaceId,
      }),
      db
        .select({ gitUrl: repositories.gitUrl })
        .from(repositories)
        .where(
          and(
            eq(repositories.orgId, orgId),
            eq(repositories.githubConnectionId, connectionId),
          ),
        ),
    ])
    const readable = new Set(bound.map((row) => row.gitUrl))
    return pins
      .filter((pin) => readable.has(pin.gitUrl))
      .map((pin) => ({ url: pin.gitUrl }))
  })
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

/** A run vault whose GitHub read rules can come on first use. */
export type DockerRunVault = RunVault & {
  /**
   * Resolves when the vault holds the GitHub read rules. Call it before a
   * command that reaches GitHub. It mints at most once.
   */
  github: () => Promise<void>
}

/**
 * Open the vault of one Docker run (a turn, a prepare, or a Workspace base
 * build). It holds a GitHub read token for the Workspace's read scope,
 * recorded under `label`. `close` deletes the vault (its proxy session stops
 * at once) and then revokes that token; the sweep revokes what a crash left.
 * Throws {@link AgentVaultUnavailableError} when the deployment has no Agent
 * Vault or it does not answer: Docker sandboxes never get a credential
 * instead.
 */
export async function openDockerRunVault(input: {
  orgId: string
  conversationId: string
  label: string
  revision: WorkspaceRevision
  /** Defaults to the deployment's (`AGENT_VAULT_ADDR`). */
  access?: AgentVaultAccess
  /**
   * What the proxy does with a host that no rule names. `deny` closes the
   * sandbox's egress to the rules (hosted AgentCore, ADR-049 amendment).
   */
  unmatchedHosts?: "passthrough" | "deny"
  /** Read only the Workspace repository, not the linked ones (a pool fill). */
  workspaceRepositoryOnly?: boolean
  /**
   * `lazy`: the vault opens with no GitHub rule, and `github` mints the
   * token and adds its rules on first use (CTX-1322). A prepare that runs no
   * Git network command then mints and revokes nothing.
   */
  github?: "now" | "lazy"
}): Promise<DockerRunVault> {
  const access = input.access ?? agentVaultAccess()
  if (!access)
    throw new AgentVaultUnavailableError(
      "Docker chat sandboxes need Agent Vault (AGENT_VAULT_ADDR is not set)",
    )
  const revokeToken = () =>
    revokeRunGitTokens({
      orgId: input.orgId,
      conversationId: input.conversationId,
      prefixes: [`${input.label}:`],
    })
  const mintRules = async () => {
    const connectionId = input.revision.remote.connectionId
    const names = input.workspaceRepositoryOnly
      ? [workspaceChatGithubRepository(input.revision.remote.url) ?? []].flat()
      : await workspaceGithubReadScope(input.orgId, input.revision)
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
    return token ? githubCredentialRules(token) : []
  }
  try {
    const lazy = input.github === "lazy"
    const vault = await openRunVault({
      access,
      runKey: `${input.conversationId}:${input.label}`,
      ttlSeconds: RUN_VAULT_TTL_SECONDS,
      rules: lazy ? [] : await mintRules(),
      ...(input.unmatchedHosts ? { unmatchedHosts: input.unmatchedHosts } : {}),
    })
    let github: Promise<void> | undefined
    return {
      ...vault,
      github: () => {
        github ??= lazy
          ? mintRules().then((rules) =>
              rules.length > 0 ? vault.addRules(rules) : undefined,
            )
          : Promise.resolve()
        return github
      },
      close: async () => {
        await vault.close()
        await revokeToken()
      },
    }
  } catch (error) {
    await revokeToken()
    throw error
  }
}

/** A command that runs Git and can reach a remote. */
const NETWORK_GIT = /\bgit\b[\s\S]*\b(?:clone|fetch|pull|push|ls-remote)\b/

/**
 * Wait for the vault's GitHub read rules before each sandbox command that
 * can reach GitHub: `git.clone`, `push` and `pull`, and each command that
 * runs Git with `clone`, `fetch`, `pull`, `push` or `ls-remote`. A lazy
 * vault (`github: "lazy"`) then mints its token only when a command needs it.
 * The agent's own commands do not pass through the handle: a turn waits for
 * the rules before the agent starts.
 */
export function withGithubBeforeNetworkGit(
  provider: SandboxProvider,
  github: () => Promise<void>,
): SandboxProvider {
  return wrapSandboxHandles(provider, (handle) => ({
    ...handle,
    process: {
      ...handle.process,
      exec: async (command, options) => {
        if (NETWORK_GIT.test(command)) await github()
        return handle.process.exec(command, options)
      },
      spawn: async (command, options) => {
        if (NETWORK_GIT.test(command)) await github()
        return handle.process.spawn(command, options)
      },
    },
    git: {
      ...handle.git,
      clone: async (input) => {
        await github()
        return handle.git.clone(input)
      },
      push: async (dir) => {
        await github()
        return handle.git.push(dir)
      },
      pull: async (dir) => {
        await github()
        return handle.git.pull(dir)
      },
    },
  }))
}
