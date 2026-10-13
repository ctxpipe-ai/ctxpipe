import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import type { NetworkPolicy } from "@vercel/sandbox"
import Docker from "dockerode"
import { parseEnv } from "../../config/env.js"
import {
  getGithubInstallationByConnectionId,
  getWorkspaceGithubReadToken,
} from "../../models/github-installation.js"
import {
  type SandboxGitTokenStore,
  sandboxGitTokenStore,
} from "../../models/sandbox-git-tokens.js"
import {
  type AgentVaultAccess,
  AgentVaultUnavailableError,
  agentVaultAccess,
  deleteRunVault,
  openRunVault,
  type RunVault,
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
import { SANDBOX_EGRESS_DENIED_PATH } from "./sandbox-egress-denied.js"
import {
  type ConversationFirewall,
  conversationFirewall,
  type HostedPolicyInput,
  type HostedTurnCredentials,
  hostRules,
  type VercelCredentials,
  vercelConversationProvider,
} from "./vercel-sandbox-provider.js"

/**
 * False until the T12 live check proves that the Vercel firewall refuses
 * each request that `ingestNetworkPolicy` does not allow. Until then,
 * `vercelIngestSandboxProvider` refuses to start.
 */
export const VERCEL_INGEST_EGRESS_PROVEN = false

/** A repository that an ingest shard reads, and its GitHub connection. */
export type IngestRepository = {
  /** `owner/name`, as the sandbox writes it in `https://<host>/<owner>/<name>.git`. */
  fullName: string
  githubConnectionId: string
}

/**
 * What one ingest step may reach (ADR-052). Nothing else: an ingest sandbox
 * has no open internet, no GitHub push, and no GitHub REST API.
 */
export type IngestEgress = {
  /**
   * The run's source repository and each destination Workspace repository.
   * The sandbox can only fetch them (the run's ingest refs too).
   */
  repositories: IngestRepository[]
  /** The model proxy base URL as the sandbox sees it (`…/openai/v1`). */
  modelProxyUrl: string
  /** The step's `workspace-ingest-model` capability. */
  capability: string
  /** The exact URL of the step's tool bridge, and its token. */
  bridge: { url: string; token: string }
  /** Defaults to `github.com`; tests use a local Git server. */
  gitHost?: string
}

/** One GitHub read token and the repositories it may fetch. */
export type IngestGitAccess = { token: string; repositories: string[] }

/**
 * The repositories of each GitHub connection. Throws when a connection does
 * not cover one of its repositories (no installation, or another owner):
 * the step would fail later inside the sandbox.
 */
async function coveredRepositoryGroups(
  orgId: string,
  repositories: IngestRepository[],
): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>()
  for (const repository of repositories) {
    const names = groups.get(repository.githubConnectionId) ?? []
    groups.set(repository.githubConnectionId, names)
    if (!names.includes(repository.fullName)) names.push(repository.fullName)
  }
  for (const [connectionId, names] of groups) {
    const installation = await getGithubInstallationByConnectionId(
      orgId,
      connectionId,
    )
    const owner = installation?.accountSlug?.toLowerCase()
    const uncovered = names.filter(
      (name) =>
        !installation?.installationId ||
        name.split("/")[0]?.toLowerCase() !== owner,
    )
    if (uncovered.length > 0)
      throw new Error(
        `The GitHub connection ${connectionId} does not cover ${uncovered.join(", ")}`,
      )
  }
  return groups
}

/**
 * One read token per GitHub connection, each for that connection's
 * repositories. The token has the read permissions of a Workspace read token
 * (contents, issues, pull requests, metadata); the egress rules allow only
 * Git fetch with it. Each token is recorded under the shard's thread, so
 * `destroy` (or the sweep, after the run) revokes it.
 */
export async function ingestGitAccess(input: {
  orgId: string
  runId: string
  shard: number
  repositories: IngestRepository[]
}): Promise<IngestGitAccess[]> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const groups = await coveredRepositoryGroups(input.orgId, input.repositories)
  const access: IngestGitAccess[] = []
  for (const [connectionId, repositories] of groups) {
    const token = await recordedRunGitToken({
      orgId: input.orgId,
      ingestThreadId: ingestSandboxThreadId(input.runId, input.shard),
      label: `git:${connectionId}`,
      mint: () =>
        getWorkspaceGithubReadToken(input.orgId, env, {
          githubConnectionId: connectionId,
          repoFullNames: repositories,
        }),
    })
    if (!token)
      throw new Error(
        `The GitHub connection ${connectionId} gave no read token for ${repositories.join(", ")}`,
      )
    access.push({ token, repositories })
  }
  return access
}

function revokeIngestGitTokens(input: {
  orgId: string
  runId: string
  shard: number
}): Promise<number> {
  return revokeRunGitTokens({
    orgId: input.orgId,
    ingestThreadId: ingestSandboxThreadId(input.runId, input.shard),
  })
}

/** The credential rules of one ingest step; the only requests it can send. */
export function ingestCredentialRules(
  egress: IngestEgress,
  git: IngestGitAccess[],
): SandboxCredentialRule[] {
  return [
    ...git.flatMap((entry) =>
      githubFetchCredentialRules(
        entry.token,
        entry.repositories,
        egress.gitHost,
      ),
    ),
    ...modelProxyCredentialRules(egress.modelProxyUrl, egress.capability),
    bearerUrlRule("tool-bridge", egress.bridge.url, egress.bridge.token),
  ]
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
 * A direct connection (not through the proxy) must fail. The DinD and AWS
 * sandbox hosts drop it with iptables; an internal Docker network has no
 * route. Host dev does neither.
 */
async function assertEgressForcedThroughProxy(
  handle: SandboxHandle,
): Promise<void> {
  const probe = await handle.process.exec(
    `command -v curl >/dev/null 2>&1 || { echo no-curl; exit 0; }
if curl -s --noproxy '*' --connect-timeout 3 -m 5 -o /dev/null http://1.1.1.1/; then echo open; else echo closed; fi`,
  )
  if (probe.stdout.trim() !== "closed")
    throw new Error(
      `Docker ingest sandboxes need a host that forces each connection through Agent Vault (the DinD or AWS sandbox host, or an internal network); a direct connection was not refused (${probe.stdout.trim() || probe.stderr.trim()})`,
    )
}

/**
 * The Docker provider of one ingest shard. `create` opens the shard's vault
 * with `unmatchedHosts: "deny"`: the proxy forwards only the rules of
 * {@link ingestCredentialRules} and refuses each other request. The
 * container gets the vault's proxy session in its environment, and the
 * proxy CA. Then `create` refuses a host where a direct connection is not
 * refused. `destroy` deletes the container and the vault, and always
 * revokes the shard's GitHub tokens.
 */
export function dockerIngestSandboxProvider(input: {
  orgId: string
  runId: string
  shard: number
  image: string
  /** The egress of the step that creates the sandbox. */
  egress: IngestEgress
  /** Defaults to the deployment's (`AGENT_VAULT_ADDR`). */
  access?: AgentVaultAccess
  /**
   * An internal Docker network: the container moves there from the default
   * bridge after create. Without it, the sandbox host must drop direct
   * connections (DinD, AWS).
   */
  network?: string
  /** Ports to publish, for example the OpenCode server's (T09). */
  publishPorts?: number[]
}): SandboxProvider {
  const docker = dockerSandbox({
    image: input.image,
    dockerodeOptions: { timeout: 120_000 },
    ...(input.publishPorts ? { publishPorts: input.publishPorts } : {}),
  })
  const runKey = ingestSandboxThreadId(input.runId, input.shard)
  return {
    name: docker.name,
    capabilities: () => docker.capabilities(),
    async create(createInput) {
      const access = requireAccess(input.access)
      let vault: RunVault | undefined
      let handle: SandboxHandle | undefined
      try {
        const git = await ingestGitAccess({
          ...input,
          repositories: input.egress.repositories,
        })
        vault = await openRunVault({
          access,
          runKey,
          ttlSeconds: INGEST_VAULT_TTL_SECONDS,
          rules: ingestCredentialRules(input.egress, git),
          unmatchedHosts: "deny",
        })
        handle = await docker.create({
          ...createInput,
          env: { ...createInput.env, ...vault.env },
        })
        if (input.network) {
          const daemon = new Docker({ timeout: 30_000 })
          await daemon
            .getNetwork(input.network)
            .connect({ Container: handle.id })
          await daemon.getNetwork("bridge").disconnect({ Container: handle.id })
        }
        await writeProxyCa(handle, vault.caPem)
        await assertEgressForcedThroughProxy(handle)
        return handle
      } catch (error) {
        if (handle)
          await docker.destroy({ id: handle.id }).catch(() => undefined)
        await vault?.close()
        await revokeIngestGitTokens(input)
        throw error
      }
    },
    resume: (resumeInput) => docker.resume(resumeInput),
    async destroy(destroyInput) {
      try {
        await docker.destroy(destroyInput)
        await deleteRunVault(requireAccess(input.access), runVaultName(runKey))
      } finally {
        // A token that is left is logged; the sweep revokes it after the run.
        await revokeIngestGitTokens(input)
      }
    },
  }
}

/**
 * Give a later step of the shard its own credentials: the step's capability,
 * its tool bridge, and GitHub tokens of the current window. Call it while the
 * step holds the shard lock, before the agent runs. It replaces the whole
 * rule set: a repository that the step does not list cannot be fetched.
 */
export async function refreshIngestSandboxEgress(input: {
  orgId: string
  runId: string
  shard: number
  egress: IngestEgress
  access?: AgentVaultAccess
}): Promise<void> {
  const git = await ingestGitAccess({
    ...input,
    repositories: input.egress.repositories,
  })
  await setRunVaultRules(
    requireAccess(input.access),
    ingestSandboxThreadId(input.runId, input.shard),
    ingestCredentialRules(input.egress, git),
    { replace: true },
  )
}

/**
 * The hosted firewall of an ingest sandbox. It has no catch-all (`"*"`):
 * the sandbox reaches GitHub fetch of its repositories, and during a step,
 * the step's model proxy and tool bridge on the backend host. The Vercel
 * firewall has no deny rule for a path: a rule's `match` only limits where
 * its transform applies. Thus each allowed host ends with a rule with no
 * match that forwards each other request to a backend route that answers
 * 403 (a GitHub push, also with a token in the URL, and every other backend
 * route). This depends on Vercel applying the first rule that matches; the
 * T12 live check must prove it.
 */
export function ingestNetworkPolicy(input: {
  git: IngestGitAccess[]
  backendHost: string
  step?: HostedTurnCredentials
}): NetworkPolicy {
  const { backendHost, step } = input
  const allow = hostRules([
    ...input.git.flatMap((entry) =>
      githubFetchCredentialRules(entry.token, entry.repositories),
    ),
    ...(step
      ? [
          bearerUrlRule(
            "tool-bridge",
            `https://${backendHost}${step.bridgePath}`,
            step.bridgeToken,
          ),
          ...modelProxyCredentialRules(
            `https://${backendHost}${step.modelProxyPath}`,
            step.modelCapability,
          ),
        ]
      : []),
  ])
  const forwardURL = `https://${backendHost}${SANDBOX_EGRESS_DENIED_PATH}`
  for (const rules of Object.values(allow)) rules.push({ forwardURL })
  return { allow }
}

/**
 * The shard's hosted GitHub token, recorded under the shard's thread
 * (`ingest:<run>:<shard>:vercel`), so `revokeFinishedIngestGitTokens`
 * revokes it after the run as for Docker.
 */
export function ingestVercelTokenStore(input: {
  orgId: string
  runId: string
  shard: number
}): SandboxGitTokenStore {
  const store = sandboxGitTokenStore(
    input.orgId,
    parseEnv(process.env as Record<string, string | undefined>),
  )
  const key = `${ingestSandboxThreadId(input.runId, input.shard)}:vercel`
  return {
    get: () => store.get(key),
    put: (_sandboxId, token) => store.put(key, token),
    take: () => store.take(key),
  }
}

/**
 * The hosted (Vercel) provider of one ingest shard: the conversation
 * provider with the closed {@link ingestNetworkPolicy}, no Workspace base,
 * and one read token for the run's repositories (one GitHub connection per
 * hosted shard). A step calls `firewall.openTurn` with its credentials while
 * it holds the shard lock, and `firewall.closeTurn` after. `destroy` deletes
 * the sandbox and revokes its token.
 *
 * It refuses to start until {@link VERCEL_INGEST_EGRESS_PROVEN}.
 */
export function vercelIngestSandboxProvider(input: {
  orgId: string
  runId: string
  shard: number
  repositories: IngestRepository[]
  backendHost: string
  credentials: VercelCredentials
  agentPassword: string
  tags: Record<string, string>
  agentSnapshot: () => Promise<string>
}): { provider: SandboxProvider; firewall: ConversationFirewall } {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const names = [
    ...new Set(input.repositories.map((repository) => repository.fullName)),
  ]
  const firewall = conversationFirewall(
    input.backendHost,
    (policy: HostedPolicyInput) =>
      ingestNetworkPolicy({
        git: [{ token: policy.gitToken, repositories: names }],
        backendHost: input.backendHost,
        ...(policy.turn ? { step: policy.turn } : {}),
      }),
  )
  const conversation = vercelConversationProvider({
    credentials: input.credentials,
    agentPassword: input.agentPassword,
    tags: input.tags,
    agentSnapshot: input.agentSnapshot,
    base: async () => ({ failed: async () => undefined }),
    access: {
      firewall,
      tokens: ingestVercelTokenStore(input),
      async mintGitToken() {
        const groups = await coveredRepositoryGroups(
          input.orgId,
          input.repositories,
        )
        const [group, ...others] = [...groups]
        if (!group || others.length > 0)
          throw new Error(
            "A hosted ingest shard reads the repositories of one GitHub connection",
          )
        const token = await getWorkspaceGithubReadToken(input.orgId, env, {
          githubConnectionId: group[0],
          repoFullNames: group[1],
        })
        if (!token)
          throw new Error("The ingest repositories have no GitHub read token")
        return token
      },
    },
  })
  const provider: SandboxProvider = {
    ...conversation,
    name: conversation.name,
    capabilities: () => conversation.capabilities(),
    async create(createInput) {
      if (!VERCEL_INGEST_EGRESS_PROVEN)
        throw new Error(
          "Hosted ingest sandboxes wait for the live Vercel egress check (T12)",
        )
      return conversation.create(createInput)
    },
  }
  return { provider, firewall }
}
