import type {
  SandboxHandle,
  SandboxProcess,
  SandboxProvider,
} from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Docker from "dockerode"

import { parseEnv } from "../../config/env.js"
import {
  getGithubInstallationByConnectionId,
  getWorkspaceGithubReadToken,
} from "../../models/github-installation.js"
import {
  type AgentVaultAccess,
  AgentVaultUnavailableError,
  agentVaultAccess,
  deleteRunVault,
  openRunVault,
  type RunVault,
  type RunVaultRule,
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
  type PlainGitRepository,
  plainGitFetchRules,
} from "./sandbox-credential-rules.js"
/**
 * A repository that an ingest shard reads: a GitHub repository and its
 * connection, or a public plain git repository that the shard reads with no
 * credential (CTX-815).
 */
export type IngestRepository =
  | {
      kind?: "github"
      /** `owner/name`, as the sandbox writes it in `https://<host>/<owner>/<name>.git`. */
      fullName: string
      githubConnectionId: string
    }
  | ({ kind: "git" } & PlainGitRepository)

type GithubIngestRepository = Exclude<IngestRepository, { kind: "git" }>

function githubIngestRepositories(
  repositories: readonly IngestRepository[],
): GithubIngestRepository[] {
  return repositories.filter(
    (repository): repository is GithubIngestRepository =>
      repository.kind !== "git",
  )
}

/** The plain git repositories of a shard, each once. */
function plainGitIngestRepositories(
  repositories: readonly IngestRepository[],
): PlainGitRepository[] {
  const found = new Map<string, PlainGitRepository>()
  for (const repository of repositories)
    if (repository.kind === "git")
      found.set(
        `${repository.host}:${repository.port ?? 443}${repository.path}`,
        {
          host: repository.host,
          path: repository.path,
          ...(repository.port ? { port: repository.port } : {}),
        },
      )
  return [...found.values()]
}

/**
 * What one ingest step may reach (ADR-052). Nothing else: an ingest sandbox
 * has no open internet, no GitHub push, and no GitHub REST API.
 */
export type IngestEgress = {
  /**
   * The run's source repository and each destination Workspace repository.
   * The sandbox can only fetch them (the run's ingest refs too). A plain git
   * source is fetched with no credential.
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
type IngestGitAccess = { token: string; repositories: string[] }

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
  for (const repository of githubIngestRepositories(repositories)) {
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

/** Revoke each recorded GitHub token of one shard; returns the count left. */
export function revokeIngestGitTokens(input: {
  orgId: string
  runId: string
  shard: number
}): Promise<number> {
  return revokeRunGitTokens({
    orgId: input.orgId,
    ingestThreadId: ingestSandboxThreadId(input.runId, input.shard),
  })
}

/**
 * The credential rules of one ingest step; the only requests it can send.
 *
 * A plain git repository gets rules only with `fetchSource`, while
 * `prepareIngestShard` clones it. A step's agent never gets them: a Git
 * fetch POSTs a body that no rule checks, so a host that an attacker runs
 * could get Workspace content in it. The rules have no credential, and they
 * match only the source's port: Agent Vault matches the host, the port, and
 * the path, not the scheme. An `https://` source gets port 443 (or its own
 * port), and an `http://` source (self-host only) gets port 80 (or its own
 * port), so the rule follows the scheme of the source.
 *
 * The rule names the host, not the checked addresses: Agent Vault resolves
 * the host name again when it connects. The backend checks the host before it makes the rule (`shardRepositories`):
 * on self-host too, it refuses a host that resolves to a cloud metadata or
 * link-local address. A DNS answer that changes after that check is not
 * covered here.
 */
export function ingestCredentialRules(
  egress: IngestEgress,
  git: IngestGitAccess[],
  options: { fetchSource?: boolean } = {},
): RunVaultRule[] {
  return [
    ...git.flatMap((entry) =>
      githubFetchCredentialRules(
        entry.token,
        entry.repositories,
        egress.gitHost,
      ),
    ),
    ...(options.fetchSource
      ? plainGitIngestRepositories(egress.repositories)
      : []
    ).flatMap((repository) =>
      plainGitFetchRules(repository).map((rule) => ({
        ...rule,
        host: `${rule.host}:${repository.port ?? 443}`,
        authorization: null,
      })),
    ),
    ...modelProxyCredentialRules(egress.modelProxyUrl, egress.capability),
    bearerUrlRule("tool-bridge", egress.bridge.url, egress.bridge.token),
  ]
}

function requireAccess(access: AgentVaultAccess | undefined): AgentVaultAccess {
  const resolved = access ?? agentVaultAccess()
  if (!resolved)
    throw new AgentVaultUnavailableError(
      "Ingest sandboxes need Agent Vault (AGENT_VAULT_ADDR is not set)",
    )
  return resolved
}

/** The vault's session outlives the shard limit, with a margin. */
const INGEST_VAULT_TTL_SECONDS = INGEST_SHARD_LIMIT_MS / 1000 + 15 * 60

/**
 * A direct connection (not through the proxy) must fail: HTTP and HTTPS to
 * a public IPv4 address, and HTTP to a public IPv6 address. The DinD and AWS
 * sandbox hosts drop it with iptables; an internal Docker network and the
 * AgentCore sandbox subnets have no route. Only these hosts are supported;
 * host dev is refused.
 */
async function assertEgressForcedThroughProxy(
  handle: SandboxHandle,
): Promise<void> {
  const probe = await handle.process.exec(
    `command -v curl >/dev/null 2>&1 || { echo no-curl; exit 0; }
for url in http://1.1.1.1/ https://1.1.1.1/ 'http://[2606:4700:4700::1111]/'; do
  if curl -sk --noproxy '*' --connect-timeout 3 -m 5 -o /dev/null "$url"; then echo "open $url"; exit 0; fi
done
echo closed`,
  )
  if (probe.stdout.trim() !== "closed")
    throw new Error(
      `Ingest sandboxes need a host that forces each connection through Agent Vault (the DinD or AWS sandbox host, an internal network, or AgentCore sandbox subnets with no internet route); a direct connection was not refused (${probe.stdout.trim() || probe.stderr.trim()})`,
    )
}

/**
 * The error of a Docker call, with an action for the operator when the
 * Docker host does not answer (no socket, a refused or timed-out connection).
 * Other errors stay as they are.
 */
export function dockerHostError(error: unknown): unknown {
  const { code, syscall } = (error ?? {}) as {
    code?: unknown
    syscall?: unknown
  }
  const down =
    (syscall === "connect" || syscall === "getaddrinfo") &&
    typeof code === "string" &&
    [
      "ECONNREFUSED",
      "ENOENT",
      "EACCES",
      "EHOSTUNREACH",
      "ETIMEDOUT",
      "ENOTFOUND",
    ].includes(code)
  return down
    ? new Error(
        "Cannot start the Docker sandbox host. Check that your deployment has Docker available.",
        { cause: error },
      )
    : error
}

/** What an ingest shard's provider needs for its vault. */
type IngestShardVaultInput = {
  orgId: string
  runId: string
  shard: number
  /**
   * The egress of the step that creates the sandbox. Absent: the provider
   * can only resume and destroy (the end of a shard).
   */
  egress?: IngestEgress
  /** Defaults to the deployment's (`AGENT_VAULT_ADDR`). */
  access?: AgentVaultAccess
}

/**
 * An ingest shard's provider around `inner`. `create` opens the shard's
 * vault with `unmatchedHosts: "deny"`: the proxy forwards only the rules of
 * {@link ingestCredentialRules} and refuses each other request. The sandbox
 * gets the vault's proxy session in its create environment, and the proxy
 * CA. Then `create` refuses a host where a direct connection is not
 * refused. `destroy` deletes the sandbox and the vault, and always revokes
 * the shard's GitHub tokens.
 */
function vaultedIngestSandboxProvider(
  inner: SandboxProvider,
  input: IngestShardVaultInput,
  hooks: {
    /** The error of a failed create, with an action for the operator. */
    createError?: (error: unknown) => unknown
    /** Runs after create, before the CA and the egress check. */
    afterCreate?: (handle: SandboxHandle) => Promise<void>
  } = {},
): SandboxProvider {
  const runKey = ingestSandboxThreadId(input.runId, input.shard)
  return {
    name: inner.name,
    capabilities: () => inner.capabilities(),
    async create(createInput) {
      const access = requireAccess(input.access)
      const egress = input.egress
      if (!egress)
        throw new Error(
          "Only a step with its egress can make an ingest sandbox",
        )
      let vault: RunVault | undefined
      let handle: SandboxHandle | undefined
      try {
        const git = await ingestGitAccess({
          ...input,
          repositories: egress.repositories,
        })
        vault = await openRunVault({
          access,
          runKey,
          ttlSeconds: INGEST_VAULT_TTL_SECONDS,
          // A new sandbox is prepared next: it fetches its source first.
          rules: ingestCredentialRules(egress, git, { fetchSource: true }),
          unmatchedHosts: "deny",
        })
        handle = await inner
          .create({ ...createInput, env: { ...createInput.env, ...vault.env } })
          .catch((error: unknown) => {
            throw hooks.createError ? hooks.createError(error) : error
          })
        await hooks.afterCreate?.(handle)
        await writeProxyCa(handle, vault.caPem)
        await assertEgressForcedThroughProxy(handle)
        return handle
      } catch (error) {
        if (handle)
          await inner.destroy({ id: handle.id }).catch(() => undefined)
        await vault?.close()
        await revokeIngestGitTokens(input)
        throw error
      }
    },
    resume: (resumeInput) => inner.resume(resumeInput),
    async destroy(destroyInput) {
      try {
        await inner.destroy(destroyInput)
      } finally {
        try {
          await deleteRunVault(
            requireAccess(input.access),
            runVaultName(runKey),
          )
        } finally {
          // A token that is left is logged; the sweep revokes it after the run.
          await revokeIngestGitTokens(input)
        }
      }
    },
  }
}

/** The Docker provider of one ingest shard; see {@link vaultedIngestSandboxProvider}. */
export function dockerIngestSandboxProvider(
  input: IngestShardVaultInput & {
    image: string
    /**
     * An internal Docker network: the container moves there from the
     * default bridge after create. Without it, the sandbox host must drop
     * direct connections (DinD, AWS).
     */
    network?: string
  },
): SandboxProvider {
  const { network } = input
  return vaultedIngestSandboxProvider(
    dockerSandbox({
      image: input.image,
      dockerodeOptions: { timeout: 120_000 },
    }),
    input,
    {
      createError: dockerHostError,
      ...(network
        ? {
            afterCreate: async (handle: SandboxHandle) => {
              const daemon = new Docker({ timeout: 30_000 })
              await daemon.getNetwork(network).connect({ Container: handle.id })
              await daemon
                .getNetwork("bridge")
                .disconnect({ Container: handle.id })
            },
          }
        : {}),
    },
  )
}

/**
 * The AgentCore provider of one ingest shard; see
 * {@link vaultedIngestSandboxProvider}. The sandbox subnets have no internet
 * route, so Agent Vault is the only way out.
 */
export function agentCoreIngestSandboxProvider(
  input: IngestShardVaultInput & { sessions: SandboxProvider },
): SandboxProvider {
  return vaultedIngestSandboxProvider(input.sessions, input, {
    afterCreate: assertNoMetadataEndpoint,
  })
}

/**
 * A metadata or credential endpoint must not answer in an ingest sandbox: a
 * prompt-injected agent could read the runtime role's credentials and write
 * them into the shard output. Docker hosts drop 169.254.169.254; nothing in
 * the image does that on AgentCore, so `create` fails closed when one of
 * these answers without the proxy (the instance metadata service over IPv4
 * and IPv6, the ECS and EKS credential endpoints).
 */
export async function assertNoMetadataEndpoint(handle: {
  process: Pick<SandboxProcess, "exec">
}): Promise<void> {
  const probe = await handle.process.exec(
    `command -v curl >/dev/null 2>&1 || { echo no-curl; exit 0; }
for url in http://169.254.169.254/ http://169.254.170.2/ http://169.254.170.23/ 'http://[fd00:ec2::254]/'; do
  code=$(curl -s --noproxy '*' --connect-timeout 2 -m 4 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then echo "open $url"; exit 0; fi
done
echo closed`,
  )
  if (probe.stdout.trim() !== "closed")
    throw new Error(
      `AgentCore ingest sandboxes must not reach a metadata or credential endpoint; the check found: ${probe.stdout.trim() || probe.stderr.trim()}`,
    )
}

/**
 * Give a later step of the shard its own credentials: the step's capability,
 * its tool bridge, and GitHub tokens that are younger than 50 minutes. Call
 * it while the step holds the shard lock, before the agent runs. It replaces
 * the whole rule set: a repository that the step does not list cannot be fetched.
 * `fetchSource` adds the plain git source, only for `prepareIngestShard`
 * (see {@link ingestCredentialRules}).
 */
export async function refreshIngestSandboxEgress(input: {
  orgId: string
  runId: string
  shard: number
  egress: IngestEgress
  fetchSource?: boolean
  access?: AgentVaultAccess
}): Promise<void> {
  const git = await ingestGitAccess({
    ...input,
    repositories: input.egress.repositories,
  })
  await setRunVaultRules(
    requireAccess(input.access),
    ingestSandboxThreadId(input.runId, input.shard),
    ingestCredentialRules(input.egress, git, {
      fetchSource: input.fetchSource === true,
    }),
    { replace: true },
  )
}
