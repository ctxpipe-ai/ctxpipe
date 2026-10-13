import type { SandboxProvider } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { parseEnv } from "../../config/env.js"
import { getWorkspaceGithubReadToken } from "../../models/github-installation.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import {
  type AgentVaultAccess,
  AgentVaultUnavailableError,
  agentVaultAccess,
  deleteRunVault,
  openRunVault,
  runVaultName,
  setRunVaultRules,
  writeProxyCa,
} from "./agent-vault.js"
import {
  INGEST_SHARD_LIMIT_MS,
  ingestSandboxThreadId,
} from "./chat-lifecycle.js"
import { recordedRunGitToken, revokeRunGitTokens } from "./run-git-tokens.js"
import {
  bearerUrlRule,
  githubFetchCredentialRules,
  modelProxyCredentialRules,
  type SandboxCredentialRule,
} from "./sandbox-credential-rules.js"
import {
  type ConversationFirewall,
  conversationFirewall,
  type VercelCredentials,
  vercelConversationProvider,
} from "./vercel-sandbox-provider.js"

/**
 * What one ingest step may reach (ADR-052). Nothing else: an ingest sandbox
 * has no open internet, no GitHub push, and no GitHub REST API.
 */
export type IngestEgress = {
  /**
   * The `owner/name` of the run's source repository and of each destination
   * Workspace repository. The sandbox can only fetch them (the run's ingest
   * refs too), with `https://<gitHost>/<owner>/<name>.git` URLs.
   */
  repositories: string[]
  /** The model proxy base URL as the sandbox sees it (`…/openai/v1`). */
  modelProxyUrl: string
  /** The step's `workspace-ingest-model` capability. */
  capability: string
  /** The exact URL of the step's tool bridge, and its token. */
  bridge: { url: string; token: string }
  /** Defaults to `github.com`; tests use a local Git server. */
  gitHost?: string
}

/** The credential rules of one ingest step; the only hosts it can reach. */
export function ingestCredentialRules(
  egress: IngestEgress,
  gitToken: string | undefined,
): SandboxCredentialRule[] {
  return [
    ...(gitToken
      ? githubFetchCredentialRules(
          gitToken,
          egress.repositories,
          egress.gitHost,
        )
      : []),
    ...modelProxyCredentialRules(egress.modelProxyUrl, egress.capability),
    bearerUrlRule("tool-bridge", egress.bridge.url, egress.bridge.token),
  ]
}

type IngestShard = {
  orgId: string
  runId: string
  shard: number
  /** The GitHub connection of the repositories, when they are on GitHub. */
  githubConnectionId: string | null
  /** Defaults to an uncached read token for `repositories`. */
  mintGitToken?: (repositories: string[]) => Promise<string | undefined>
  /** Defaults to GitHub's revoke endpoint. */
  revokeGitToken?: (token: string) => Promise<void>
}

/**
 * The shard's GitHub read token: contents read only, for the source and the
 * destination repositories. It is recorded under the shard's thread, so
 * `destroy` (or the sweep, after the run) revokes it.
 */
function ingestGitToken(
  shard: IngestShard,
  repositories: string[],
): Promise<string | undefined> {
  const connectionId = shard.githubConnectionId
  const mint =
    shard.mintGitToken ??
    ((names: string[]) =>
      connectionId
        ? getWorkspaceGithubReadToken(
            shard.orgId,
            parseEnv(process.env as Record<string, string | undefined>),
            { githubConnectionId: connectionId, repoFullNames: names },
          )
        : Promise.resolve(undefined))
  if (repositories.length === 0) return Promise.resolve(undefined)
  return recordedRunGitToken({
    orgId: shard.orgId,
    ingestThreadId: ingestSandboxThreadId(shard.runId, shard.shard),
    label: "git",
    mint: () => mint(repositories),
    ...(shard.revokeGitToken ? { revoke: shard.revokeGitToken } : {}),
  })
}

function revokeIngestGitTokens(shard: IngestShard): Promise<number> {
  return revokeRunGitTokens({
    orgId: shard.orgId,
    ingestThreadId: ingestSandboxThreadId(shard.runId, shard.shard),
    ...(shard.revokeGitToken ? { revoke: shard.revokeGitToken } : {}),
  })
}

function requireAccess(access: AgentVaultAccess | undefined): AgentVaultAccess {
  const resolved = access ?? agentVaultAccess()
  if (!resolved)
    throw new AgentVaultUnavailableError(
      "Docker ingest sandboxes need Agent Vault (AGENT_VAULT_ADDR is not set)",
    )
  return resolved
}

/** The vault's session outlives the shard limit, with a margin. */
const INGEST_VAULT_TTL_SECONDS = INGEST_SHARD_LIMIT_MS / 1000 + 15 * 60

/**
 * The Docker provider of one ingest shard. `create` opens the shard's vault
 * with `unmatchedHosts: "deny"`: the proxy forwards only the rules of
 * {@link ingestCredentialRules} and refuses each other request. The
 * container gets the vault's proxy session in its environment, and the
 * proxy CA. `destroy` deletes the container, then the vault (its session
 * stops at once), then revokes the shard's GitHub tokens.
 *
 * The vault refuses hosts, but it cannot stop a direct connection: the
 * sandbox host must force each connection through the proxy (the DinD and
 * AWS hosts do; host dev does not).
 */
export function dockerIngestSandboxProvider(
  input: IngestShard & {
    image: string
    /** The egress of the step that creates the sandbox. */
    egress: () => Promise<IngestEgress>
    /** Defaults to the deployment's (`AGENT_VAULT_ADDR`). */
    access?: AgentVaultAccess
  },
): SandboxProvider {
  const docker = dockerSandbox({
    image: input.image,
    dockerodeOptions: { timeout: 120_000 },
  })
  const runKey = ingestSandboxThreadId(input.runId, input.shard)
  return {
    name: docker.name,
    capabilities: () => docker.capabilities(),
    async create(createInput) {
      const access = requireAccess(input.access)
      const egress = await input.egress()
      let vault: Awaited<ReturnType<typeof openRunVault>> | undefined
      try {
        const gitToken = await ingestGitToken(input, egress.repositories)
        vault = await openRunVault({
          access,
          runKey,
          ttlSeconds: INGEST_VAULT_TTL_SECONDS,
          rules: ingestCredentialRules(egress, gitToken),
          unmatchedHosts: "deny",
        })
        const handle = await docker.create({
          ...createInput,
          env: { ...createInput.env, ...vault.env },
        })
        try {
          await writeProxyCa(handle, vault.caPem)
        } catch (error) {
          await docker.destroy({ id: handle.id }).catch(() => undefined)
          throw error
        }
        return handle
      } catch (error) {
        await vault?.close()
        await revokeIngestGitTokens(input)
        throw error
      }
    },
    resume: (resumeInput) => docker.resume(resumeInput),
    async destroy(destroyInput) {
      await docker.destroy(destroyInput)
      await deleteRunVault(requireAccess(input.access), runVaultName(runKey))
      // A token that is left is logged; the sweep revokes it after the run.
      await revokeIngestGitTokens(input)
    },
  }
}

/**
 * Give a later step of the shard its own credentials: the step's capability,
 * its tool bridge, and a GitHub token of the current window. Call it while
 * the step holds the shard lock, before the agent runs. The rule names stay
 * the same, so each rule of the earlier step is replaced.
 */
export async function refreshIngestSandboxEgress(
  input: IngestShard & { egress: IngestEgress; access?: AgentVaultAccess },
): Promise<void> {
  const gitToken = await ingestGitToken(input, input.egress.repositories)
  await setRunVaultRules(
    requireAccess(input.access),
    ingestSandboxThreadId(input.runId, input.shard),
    ingestCredentialRules(input.egress, gitToken),
  )
}

/**
 * The hosted (Vercel) provider of one ingest shard: the conversation
 * provider with a closed firewall (`hostedNetworkPolicy` with
 * `ingestRepositories`, no `"*"`), no Workspace base, and a read token for
 * the run's repositories. A step calls `firewall.openTurn` with its
 * credentials (model proxy path, capability, tool bridge) while it holds the
 * shard lock, and `firewall.closeTurn` after. `destroy` deletes the sandbox
 * and revokes its token.
 */
export function vercelIngestSandboxProvider(input: {
  orgId: string
  githubConnectionId: string
  /** The `owner/name` of the source and destination repositories. */
  repositories: string[]
  backendHost: string
  credentials: VercelCredentials
  agentPassword: string
  tags: Record<string, string>
  agentSnapshot: () => Promise<string>
}): { provider: SandboxProvider; firewall: ConversationFirewall } {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const firewall = conversationFirewall(input.backendHost, {
    ingestRepositories: input.repositories,
  })
  const provider = vercelConversationProvider({
    credentials: input.credentials,
    agentPassword: input.agentPassword,
    tags: input.tags,
    agentSnapshot: input.agentSnapshot,
    base: async () => ({ failed: async () => undefined }),
    access: {
      firewall,
      tokens: sandboxGitTokenStore(input.orgId, env),
      async mintGitToken() {
        const token = await getWorkspaceGithubReadToken(input.orgId, env, {
          githubConnectionId: input.githubConnectionId,
          repoFullNames: input.repositories,
        })
        if (!token)
          throw new Error("The ingest repositories have no GitHub read token")
        return token
      },
    },
  })
  return { provider, firewall }
}
