import { createHash } from "node:crypto"
import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox"
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
import { log } from "../../observability/logger.js"
import { type RootExec, vercelRootExec } from "../ingestion/ingest-root.js"
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
import { revokeGithubToken } from "./clone-credentials.js"
import { ingestEgressForwardUrl } from "./ingest-egress-proxy.js"
import { recordedRunGitToken, revokeRunGitTokens } from "./run-git-tokens.js"
import {
  bearerUrlRule,
  githubFetchCredentialRules,
  modelProxyCredentialRules,
  type PlainGitRepository,
  plainGitFetchRules,
} from "./sandbox-credential-rules.js"
import {
  type ConversationFirewall,
  conversationFirewall,
  type HostedPolicyInput,
  type HostedTurnCredentials,
  type VercelCredentials,
  vercelConfigured,
  vercelConversationProvider,
} from "./vercel-sandbox-provider.js"

/**
 * True since the live check proved the hosted egress proxy (T03b,
 * `ingestNetworkPolicy` and `ingestEgressProxy`) on a real Vercel sandbox.
 * When it is false, `vercelIngestSandboxProvider` refuses to start.
 */
export const VERCEL_INGEST_EGRESS_PROVEN = true

/**
 * Whether hosted ingest egress is on: the egress route is mounted and ingest
 * sandboxes may start. One predicate for both, so a sandbox never starts
 * without the route that serves it.
 */
export function hostedIngestEgressEnabled(
  env: NodeJS.ProcessEnv = process.env,
  proven: boolean = VERCEL_INGEST_EGRESS_PROVEN,
): boolean {
  return proven && vercelConfigured(env)
}

/**
 * Throws until hosted ingest egress is on (see `hostedIngestEgressEnabled`).
 * Each create, resume, and step of a hosted ingest sandbox calls it first.
 * Destroy and the sweep do not: they must work while the gate is closed.
 */
export function assertHostedIngestEgress(
  proven: boolean = VERCEL_INGEST_EGRESS_PROVEN,
): void {
  if (!hostedIngestEgressEnabled(process.env, proven))
    throw new Error(
      "Hosted ingest sandboxes wait for the live Vercel egress check (T12)",
    )
}

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
export function plainGitIngestRepositories(
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
      "Docker ingest sandboxes need Agent Vault (AGENT_VAULT_ADDR is not set)",
    )
  return resolved
}

/** The vault's session outlives the shard limit, with a margin. */
const INGEST_VAULT_TTL_SECONDS = INGEST_SHARD_LIMIT_MS / 1000 + 15 * 60

/**
 * A direct connection (not through the proxy) must fail: HTTP and HTTPS to
 * a public IPv4 address, and HTTP to a public IPv6 address. The DinD and AWS
 * sandbox hosts drop it with iptables; an internal Docker network has no
 * route. Only these hosts are supported; host dev is refused.
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
  /**
   * The egress of the step that creates the sandbox. Absent: the provider
   * can only resume and destroy (the end of a shard).
   */
  egress?: IngestEgress
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

/**
 * Private, loopback, link-local (cloud metadata), and shared address ranges.
 * The sandbox must not reach them, also through an allowed name. IPv4 only:
 * the Vercel API refuses an IPv6 range ("Invalid CIDR"). The policy allows
 * no IPv6 address, so the sandbox has no IPv6 route out of it.
 */
const PRIVATE_SUBNETS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
]

/**
 * The hosted firewall of an ingest sandbox (T03b). It allows `github.com`
 * and the backend host, and forwards each request to them to the backend
 * egress proxy (`ingestEgressProxy`). The proxy allows only Git fetch of the
 * shard's repositories and, during a step, the step's model proxy and tool
 * bridge, and it adds each credential. Each other request
 * gets 403; each other host is not allowed. The forward URL carries the
 * sealed scope, bound to the sandbox name, so no credential is in the
 * policy. A sandbox with no name yet (at create) gets `"deny-all"`.
 *
 * The host of each plain git repository of the shard (CTX-815) is allowed
 * only while `prepareIngestShard` fetches the source (`step.fetchSource`),
 * never while a step's agent runs: see `ingestCredentialRules`.
 */
export function ingestNetworkPolicy(input: {
  git: IngestGitAccess[]
  /** The public plain git repositories of the shard (CTX-815). */
  plainGit?: PlainGitRepository[]
  backendHost: string
  step?: HostedTurnCredentials
  /** The Vercel sandbox name; the egress proxy refuses other sandboxes. */
  sandboxName?: string
  /** The seal secret (`AUTH_SECRET`); the backend opens the scope with it. */
  secret: string
}): NetworkPolicy {
  if (!input.sandboxName) return "deny-all"
  const plainGit = input.step?.fetchSource ? (input.plainGit ?? []) : []
  // Each update seals a new scope; one shard runs at most this long.
  const base = {
    sandbox: input.sandboxName,
    exp: Date.now() + INGEST_SHARD_LIMIT_MS,
    backendHost: input.backendHost,
  }
  // Each host gets only its own part of the scope: the Git hosts the Git
  // fetch, the backend host the step's credentials. Vercel answers 500 to
  // a policy whose forward URLs are too long together (CTX-887).
  const gitURL = ingestEgressForwardUrl(
    { ...base, git: input.git, ...(plainGit.length ? { plainGit } : {}) },
    input.secret,
  )
  const backendURL = ingestEgressForwardUrl(
    { ...base, git: [], ...(input.step ? { step: input.step } : {}) },
    input.secret,
  )
  const forwardURLs = gitURL.length * (1 + plainGit.length) + backendURL.length
  if (forwardURLs > INGEST_POLICY_MAX_FORWARD_URL_LENGTH)
    throw new Error(
      `The ingest firewall policy has ${forwardURLs} characters of forward URLs; the Vercel API refuses more than about ${INGEST_POLICY_MAX_FORWARD_URL_LENGTH}`,
    )
  return {
    allow: {
      "github.com": [{ forwardURL: gitURL }],
      // During the source fetch, each plain git host goes to the egress
      // proxy too, which allows only Git fetch of the shard's repository
      // paths on it.
      ...Object.fromEntries(
        plainGit.map((repository) => [
          repository.host,
          [{ forwardURL: gitURL }],
        ]),
      ),
      [input.backendHost]: [{ forwardURL: backendURL }],
    },
    subnets: { deny: PRIVATE_SUBNETS },
  }
}

/**
 * The forward URLs of one policy, all together. The Vercel API accepted
 * 4,000 characters and answered 500 to 4,096 (a probe on 2026-10-19).
 */
export const INGEST_POLICY_MAX_FORWARD_URL_LENGTH = 3_600

/**
 * The shard's hosted GitHub tokens, recorded under the shard's thread
 * (`ingest:<run>:<shard>:vercel:<token hash>`), so `destroy` and
 * `revokeFinishedIngestGitTokens` (after the run) revoke each, as for
 * Docker. Each token has its own record: a rotation adds the new token and
 * keeps the old one until it is revoked, so no token that a sandbox used is
 * ever without a record. `get` uses the newest token.
 *
 * `take` gives no token and removes no record. A record goes only after
 * GitHub confirms the revoke: `revokeIngestGitTokens` (at `destroy`, and in
 * the sweep) revokes each token and then removes its record. Thus a failed
 * revoke leaves the record for the sweep.
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
  const prefix = `${ingestSandboxThreadId(input.runId, input.shard)}:vercel:`
  const newest = async () =>
    (await store.list(prefix)).sort(
      (a, b) => b.mintedAt.getTime() - a.mintedAt.getTime(),
    )[0]
  return {
    get: async () => {
      const row = await newest()
      return row ? { token: row.token, mintedAt: row.mintedAt } : null
    },
    put: async (_sandboxId, token) => {
      await store.add(
        `${prefix}${createHash("sha256").update(token).digest("hex").slice(0, 32)}`,
        token,
      )
    },
    take: async () => null,
  }
}

/** Tags of a hosted ingest sandbox; `environment` first (see `listTaggedSandboxes`). */
export function ingestSandboxTags(environment: string): Record<string, string> {
  return { environment, ctxpipe: "workspace-ingest" }
}

/**
 * The hosted (Vercel) provider of one ingest shard: the conversation
 * provider with the closed {@link ingestNetworkPolicy}, no Workspace base,
 * no public port, and one read token for the run's repositories (one GitHub
 * connection per hosted shard). The token is recorded as soon as it is
 * minted. A step calls `firewall.openTurn` with its credentials while it
 * holds the shard lock, and `firewall.closeTurn` after. `root` runs root
 * scripts through the SDK's `sudo` option. `destroy` deletes the sandbox and
 * revokes each token of the shard.
 *
 * It refuses to create or resume a sandbox until
 * {@link VERCEL_INGEST_EGRESS_PROVEN}.
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
  /**
   * Only the hosted contract test sets it: the live egress proof that
   * {@link VERCEL_INGEST_EGRESS_PROVEN} waits for runs there.
   */
  proven?: boolean
}): {
  provider: SandboxProvider
  firewall: ConversationFirewall
  root: (sandboxName: string) => Promise<RootExec>
} {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const names = [
    ...new Set(
      githubIngestRepositories(input.repositories).map(
        (repository) => repository.fullName,
      ),
    ),
  ]
  const plainGit = plainGitIngestRepositories(input.repositories)
  const firewall = conversationFirewall(
    input.backendHost,
    (policy: HostedPolicyInput) =>
      ingestNetworkPolicy({
        git: [{ token: policy.gitToken, repositories: names }],
        plainGit,
        backendHost: input.backendHost,
        secret: env.AUTH_SECRET,
        ...(policy.sandboxName ? { sandboxName: policy.sandboxName } : {}),
        ...(policy.turn ? { step: policy.turn } : {}),
      }),
  )
  const tokens = ingestVercelTokenStore(input)
  const conversation = vercelConversationProvider({
    credentials: input.credentials,
    agentPassword: input.agentPassword,
    tags: input.tags,
    agentSnapshot: input.agentSnapshot,
    base: async () => ({ failed: async () => undefined }),
    // No agent server: nothing outside may connect to the sandbox.
    ports: [],
    // A shard runs at most the shard limit; the sweep deletes it after.
    timeoutMs: INGEST_SHARD_LIMIT_MS + 5 * 60_000,
    access: {
      firewall,
      tokens,
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
        // Recorded before any use, so a crash leaves it to the sweep. A
        // token with no record is revoked here, or nothing revokes it.
        try {
          await tokens.put("", token)
        } catch (error) {
          await revokeGithubToken(token).catch((revokeError: unknown) =>
            log.warn({
              step: "ingest-git-token-revoke",
              message: `Revoking a hosted ingest GitHub token with no record failed: ${String(revokeError)}`,
              orgId: input.orgId,
              runId: input.runId,
            }),
          )
          throw error
        }
        return token
      },
    },
  })
  const provider: SandboxProvider = {
    ...conversation,
    name: conversation.name,
    capabilities: () => conversation.capabilities(),
    async create(createInput) {
      assertHostedIngestEgress(input.proven)
      return conversation.create(createInput)
    },
    // A resume attaches the sandbox and gives it a firewall policy with a
    // GitHub token: the same gate as create.
    async resume(resumeInput) {
      assertHostedIngestEgress(input.proven)
      return conversation.resume(resumeInput)
    },
    async destroy(destroyInput) {
      try {
        await conversation.destroy(destroyInput)
      } finally {
        // A token that is left is logged; the sweep revokes it after the run.
        await revokeIngestGitTokens(input)
      }
    },
  }
  return {
    provider,
    firewall,
    root: async (sandboxName) =>
      vercelRootExec(
        await Sandbox.get({
          ...input.credentials,
          name: sandboxName,
          resume: false,
        }),
      ),
  }
}
