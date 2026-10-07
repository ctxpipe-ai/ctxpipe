import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { readFile } from "node:fs/promises"
import { isIP } from "node:net"
import { AgentVault, type ServiceInput } from "@infisical/agent-vault-sdk"
import { log } from "../../observability/logger.js"

/**
 * Agent Vault (Infisical, open source) adds the credentials of Docker
 * sandboxes in flight. A sandbox gets only a proxy session; the vault of its
 * run holds each credential and the rule that adds it. The deployment runs
 * Agent Vault and generates its owner password; the backend registers the
 * owner on first use and logs in after that.
 */

/** The owner account of the backend. The address is never sent mail. */
const OWNER_EMAIL = "backend@agent-vault.ctxpipe.internal"
const PROXY_PORT = 14322
const RUN_VAULT_PREFIX = "ctxpipe-run-"
const REQUEST_TIMEOUT_MS = 10_000

/** Where a sandbox finds the proxy's CA certificate. */
export const SANDBOX_PROXY_CA_PATH = "/tmp/ctxpipe-proxy-ca.pem"

/**
 * The credential value a sandbox sees. The proxy replaces the whole header,
 * so this text is never a credential.
 */
export const SANDBOX_CREDENTIAL_PLACEHOLDER = "added-by-proxy"

/** Agent Vault is not configured or does not answer: Docker chat fails closed. */
export class AgentVaultUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AgentVaultUnavailableError"
  }
}

export type AgentVaultAccess = {
  /** The API, for example `http://agent-vault:14321`. */
  address: string
  /**
   * The proxy's `host:port` as sandboxes dial it, when it is not the API's
   * host on port 14322 (a published port in tests).
   */
  proxyAddress?: string
  ownerPassword: () => Promise<string>
}

/**
 * The deployment's Agent Vault, or undefined when it has none. Compose gives
 * the owner password as a file on a shared volume; AWS gives it as a value
 * from Secrets Manager.
 */
export function agentVaultAccess(
  env: Record<string, string | undefined> = process.env,
): AgentVaultAccess | undefined {
  const address = env.AGENT_VAULT_ADDR?.trim()
  if (!address) return undefined
  const value = env.AGENT_VAULT_OWNER_PASSWORD?.trim()
  const file = env.AGENT_VAULT_OWNER_PASSWORD_FILE?.trim()
  const proxyAddress = env.AGENT_VAULT_PROXY_ADDR?.trim()
  return {
    address: address.replace(/\/$/, ""),
    ...(proxyAddress ? { proxyAddress } : {}),
    ownerPassword: async () => {
      if (value) return value
      if (!file)
        throw new AgentVaultUnavailableError(
          "The Agent Vault owner password is not configured",
        )
      return (await readFile(file, "utf8")).trim()
    },
  }
}

/** One credential rule: a host pattern (with an optional path glob) and its header. */
export type RunVaultRule = {
  name: string
  host: string
} & ({ bearer: string } | { basic: { username: string; password: string } })

export type RunVault = {
  name: string
  /** The sandbox's environment: proxy session and CA trust. No credential. */
  env: Record<string, string>
  /** The proxy's CA certificate (public), for {@link SANDBOX_PROXY_CA_PATH}. */
  caPem: string
  addRules: (rules: RunVaultRule[]) => Promise<void>
  /** Delete the vault; its session stops at once. Never throws. */
  close: () => Promise<void>
}

const ownerTokens = new Map<string, Promise<string>>()

async function avFetch(
  access: AgentVaultAccess,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  try {
    return await fetch(`${access.address}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new AgentVaultUnavailableError(
      `Agent Vault is not reachable at ${access.address}`,
      { cause: error },
    )
  }
}

async function login(access: AgentVaultAccess): Promise<string> {
  const password = await access.ownerPassword()
  const credentials = { email: OWNER_EMAIL, password }
  const loggedIn = await avFetch(access, "/v1/auth/login", {
    method: "POST",
    body: credentials,
  })
  if (loggedIn.ok) return ((await loggedIn.json()) as { token: string }).token
  // A new Agent Vault has no owner: the first account becomes the owner.
  const registered = await avFetch(access, "/v1/auth/register", {
    method: "POST",
    body: credentials,
  })
  const body = (await registered.json().catch(() => ({}))) as {
    token?: string
  }
  if (registered.ok && body.token) return body.token
  throw new AgentVaultUnavailableError(
    `Agent Vault refused the backend's owner account (${loggedIn.status}, ${registered.status})`,
  )
}

async function ownerToken(
  access: AgentVaultAccess,
  refresh = false,
): Promise<string> {
  const cached = ownerTokens.get(access.address)
  if (cached && !refresh) return cached
  const next = login(access)
  ownerTokens.set(access.address, next)
  next.catch(() => ownerTokens.delete(access.address))
  return next
}

/** Run `fn` with an owner client; logs in again once when the session ended. */
async function asOwner<T>(
  access: AgentVaultAccess,
  fn: (client: AgentVault, token: string) => Promise<T>,
): Promise<T> {
  const attempt = async (refresh: boolean) => {
    const token = await ownerToken(access, refresh)
    return fn(
      new AgentVault({
        token,
        address: access.address,
        timeout: REQUEST_TIMEOUT_MS,
      }),
      token,
    )
  }
  try {
    return await attempt(false)
  } catch (error) {
    if ((error as { status?: number }).status === 401) return attempt(true)
    throw unavailable(error)
  }
}

function unavailable(error: unknown): Error {
  if (error instanceof AgentVaultUnavailableError) return error
  const status = (error as { status?: number }).status
  if (status === undefined)
    return new AgentVaultUnavailableError("Agent Vault is not reachable", {
      cause: error,
    })
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * The address a sandbox dials: an IP, because sandboxes resolve no names.
 * Agent Vault on this machine (host dev, CI) is the sandbox's Docker host,
 * which every Docker sandbox has in its hosts file.
 */
async function proxyAddress(access: AgentVaultAccess): Promise<string> {
  if (access.proxyAddress) return access.proxyAddress
  return `${await proxyHost(access)}:${PROXY_PORT}`
}

async function proxyHost(access: AgentVaultAccess): Promise<string> {
  const host = new URL(access.address).hostname.replace(/^\[(.*)\]$/, "$1")
  if (host === "localhost" || host.startsWith("127.") || host === "::1")
    return "host.docker.internal"
  if (isIP(host)) return host.includes(":") ? `[${host}]` : host
  try {
    return (await lookup(host, { family: 4 })).address
  } catch (error) {
    throw new AgentVaultUnavailableError(
      `Agent Vault is not reachable at ${access.address}`,
      { cause: error },
    )
  }
}

function credentialKey(rule: string, part: string): string {
  return `${rule.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_${part}`
}

function servicesFor(rules: RunVaultRule[]): {
  credentials: Record<string, string>
  services: ServiceInput[]
} {
  const credentials: Record<string, string> = {}
  const services: ServiceInput[] = rules.map((rule) => {
    if ("bearer" in rule) {
      const token = credentialKey(rule.name, "TOKEN")
      credentials[token] = rule.bearer
      return {
        name: rule.name,
        host: rule.host,
        auth: { type: "bearer", token },
      }
    }
    const username = credentialKey(rule.name, "USER")
    const password = credentialKey(rule.name, "PASSWORD")
    credentials[username] = rule.basic.username
    credentials[password] = rule.basic.password
    return {
      name: rule.name,
      host: rule.host,
      auth: { type: "basic", username, password },
    }
  })
  return { credentials, services }
}

/** The vault name of a run: stable, so a retry and the sweep find it. */
export function runVaultName(runKey: string): string {
  return `${RUN_VAULT_PREFIX}${createHash("sha256").update(runKey).digest("hex").slice(0, 40)}`
}

/**
 * Create the run's vault with `rules` and a proxy session for the sandbox.
 * Throws {@link AgentVaultUnavailableError} when Agent Vault does not answer.
 */
export async function openRunVault(input: {
  access: AgentVaultAccess
  runKey: string
  ttlSeconds: number
  rules: RunVaultRule[]
}): Promise<RunVault> {
  const { access } = input
  const name = runVaultName(input.runKey)
  const proxyAt = await proxyAddress(access)
  const addRules = async (rules: RunVaultRule[]) => {
    if (rules.length === 0) return
    const { credentials, services } = servicesFor(rules)
    await asOwner(access, async (client) => {
      const vault = client.vault(name)
      await vault.credentials?.set(credentials)
      await vault.services?.set(services)
    })
  }
  const close = async () => {
    await deleteRunVault(access, name).catch((error: unknown) =>
      log.warn({
        step: "agent-vault-run-close",
        message: `Deleting a run vault failed; the sweep deletes it: ${String(error)}`,
      }),
    )
  }
  const session = await asOwner(access, async (client) => {
    try {
      await client.createVault({ name })
    } catch (error) {
      // A retry of the same run reuses its vault.
      if ((error as { status?: number }).status !== 409) throw error
    }
    return client.vault(name).sessions?.create({ ttlSeconds: input.ttlSeconds })
  })
  try {
    await addRules(input.rules)
    if (!session) throw new AgentVaultUnavailableError("No proxy session")
    const ca = await avFetch(access, "/v1/mitm/ca.pem")
    if (!ca.ok)
      throw new AgentVaultUnavailableError(
        "Agent Vault has no proxy CA (its TLS proxy is off)",
      )
    const caPem = await ca.text()
    const proxy = `http://${session.token}:${name}@${proxyAt}`
    const noProxy = "localhost,127.0.0.1"
    return {
      name,
      caPem,
      addRules,
      close,
      env: {
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        NODE_USE_ENV_PROXY: "1",
        SSL_CERT_FILE: SANDBOX_PROXY_CA_PATH,
        NODE_EXTRA_CA_CERTS: SANDBOX_PROXY_CA_PATH,
        GIT_SSL_CAINFO: SANDBOX_PROXY_CA_PATH,
        REQUESTS_CA_BUNDLE: SANDBOX_PROXY_CA_PATH,
        CURL_CA_BUNDLE: SANDBOX_PROXY_CA_PATH,
      },
    }
  } catch (error) {
    await close()
    throw unavailable(error)
  }
}

export async function deleteRunVault(
  access: AgentVaultAccess,
  name: string,
): Promise<void> {
  await asOwner(access, async (client) => {
    try {
      await client.deleteVault(name)
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
    }
  })
}

/**
 * Delete run vaults older than `minAgeMs` that a turn end did not delete.
 * Returns the count deleted. Never throws.
 */
export async function sweepRunVaults(
  access: AgentVaultAccess,
  minAgeMs: number,
): Promise<number> {
  try {
    const listed = await asOwner(access, async (_client, token) => {
      const response = await avFetch(access, "/v1/vaults", { token })
      if (!response.ok)
        throw Object.assign(new Error("Listing vaults failed"), {
          status: response.status,
        })
      return (await response.json()) as {
        vaults: Array<{ name: string; created_at: string }>
      }
    })
    let deleted = 0
    for (const vault of listed.vaults) {
      if (!vault.name.startsWith(RUN_VAULT_PREFIX)) continue
      if (Date.now() - Date.parse(vault.created_at) < minAgeMs) continue
      await deleteRunVault(access, vault.name)
      deleted += 1
    }
    return deleted
  } catch (error) {
    log.warn({
      step: "agent-vault-sweep",
      message: `Sweeping run vaults failed: ${String(error)}`,
    })
    return 0
  }
}

/**
 * The run's GitHub rules: Basic `x-access-token` for Git (`github.com`,
 * `codeload.github.com`) and Bearer for the REST API, so `git` and `gh`
 * work with no token in the sandbox.
 */
export function githubRules(token: string): RunVaultRule[] {
  const basic = { username: "x-access-token", password: token }
  return [
    { name: "github-git", host: "github.com", basic },
    { name: "github-codeload", host: "codeload.github.com", basic },
    { name: "github-api", host: "api.github.com", bearer: token },
  ]
}

/** The shell command that writes the proxy CA into a sandbox. */
export function writeProxyCaCommand(caPem: string): string {
  return `mkdir -p "$(dirname ${SANDBOX_PROXY_CA_PATH})" && printf '%s\\n' '${caPem.trim().replace(/'/g, "")}' > ${SANDBOX_PROXY_CA_PATH}`
}
