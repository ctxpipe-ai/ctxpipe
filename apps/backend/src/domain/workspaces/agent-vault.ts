import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { readFile } from "node:fs/promises"
import { isIP } from "node:net"
import {
  AgentVault,
  buildProxyEnv,
  type ServiceInput,
} from "@infisical/agent-vault-sdk"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { log } from "../../observability/logger.js"
import type { SandboxCredentialRule } from "./sandbox-credential-rules.js"

/**
 * Agent Vault (Infisical, open source) adds the credentials of Docker
 * sandboxes in flight. A sandbox gets only a proxy session; the vault of its
 * run holds each credential and the rule that adds it. The deployment runs
 * Agent Vault and generates its owner password; the backend registers the
 * owner while the instance has none, and logs in after that.
 */

/** The owner account of the backend. The address is never sent mail. */
const OWNER_EMAIL = "backend@agent-vault.ctxpipe.internal"
const RUN_VAULT_PREFIX = "ctxpipe-run-"
const REQUEST_TIMEOUT_MS = 10_000

/** Where a sandbox finds the proxy's CA certificate. */
export const SANDBOX_PROXY_CA_PATH = "/tmp/ctxpipe-proxy-ca.pem"

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
   * The proxy's host as sandboxes dial it, when it is not derived from the
   * API's host. Tests set it (an address on a test network); deployments do
   * not. The port is the one Agent Vault reports.
   */
  proxyHost?: string
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
  return {
    address: address.replace(/\/$/, ""),
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

/**
 * A rule of a run vault. A rule with a null `authorization` allows its
 * exact host and path with no credential (a public plain git repository,
 * CTX-815).
 */
export type RunVaultRule = Omit<SandboxCredentialRule, "authorization"> & {
  authorization: string | null
}

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

/** What an Agent Vault request answered: the status and the parsed JSON body. */
type AvResponse = { ok: boolean; status: number; body: Record<string, unknown> }

/**
 * A fetch whose timeout covers the whole exchange: the body is read here,
 * under the timer, so a body that stops cannot hang the caller and no timer
 * outlives the request. The SDK clears its own timer at the headers, so it
 * uses this fetch too.
 */
async function boundedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const abort = new AbortController()
  const timer = setTimeout(
    () => abort.abort(new Error(`No answer in ${REQUEST_TIMEOUT_MS} ms`)),
    REQUEST_TIMEOUT_MS,
  )
  try {
    const response = await fetch(input, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, abort.signal])
        : abort.signal,
    })
    const body = await response.arrayBuffer()
    return new Response(body.byteLength === 0 ? null : body, response)
  } finally {
    clearTimeout(timer)
  }
}

/** One request to the Agent Vault API, with its JSON body parsed. */
async function avFetch(
  access: AgentVaultAccess,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<AvResponse> {
  try {
    const response = await boundedFetch(`${access.address}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object") body = parsed as typeof body
    } catch {
      // A body that is not JSON (an error page) has no fields.
    }
    return { ok: response.ok, status: response.status, body }
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
  if (loggedIn.ok && typeof loggedIn.body.token === "string")
    return loggedIn.body.token
  // Register only while the instance has no owner (the first account becomes
  // the owner). An instance with an owner that refuses this password stays
  // closed: the password changed, or another backend owns it.
  const status = await avFetch(access, "/v1/status")
  const initialized = status.ok ? status.body.needs_first_user === false : true
  if (initialized)
    throw new AgentVaultUnavailableError(
      `Agent Vault refused the backend's owner password (${loggedIn.status}); see "Agent Vault owner password" in the self-hosting docs`,
    )
  const registered = await avFetch(access, "/v1/auth/register", {
    method: "POST",
    body: credentials,
  })
  if (registered.ok && typeof registered.body.token === "string")
    return registered.body.token
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
        // The SDK calls only the function; it never preconnects.
        fetch: boundedFetch as typeof fetch,
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
async function proxyHost(access: AgentVaultAccess): Promise<string> {
  if (access.proxyHost) return access.proxyHost
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

/**
 * Each rule as an Agent Vault service that sets the whole `Authorization`
 * header (a path rule matches that exact path). Agent Vault sets the `Host`
 * header from the target it dials, so a rule cannot send its header to
 * another site. A rule with no credential is a passthrough service: the
 * proxy allows its exact host and path and adds no header.
 */
function servicesFor(rules: RunVaultRule[]): {
  credentials: Record<string, string>
  services: ServiceInput[]
} {
  const credentials: Record<string, string> = {}
  const services: ServiceInput[] = rules.map((rule) => {
    const host = `${rule.host}${rule.path ?? ""}`
    if (rule.authorization === null)
      return { name: rule.name, host, auth: { type: "passthrough" } }
    const key = credentialKey(rule.name, "AUTHORIZATION")
    credentials[key] = rule.authorization
    return {
      name: rule.name,
      host,
      auth: { type: "custom", headers: { Authorization: `{{ ${key} }}` } },
    }
  })
  return { credentials, services }
}

/** The vault name of a run: stable, so a retry and the sweep find it. */
export function runVaultName(runKey: string): string {
  return `${RUN_VAULT_PREFIX}${createHash("sha256").update(runKey).digest("hex").slice(0, 40)}`
}

/**
 * Add `rules` to the run's vault, or replace the rules with the same names
 * (Agent Vault keys a service by its name). With `replace`, the vault keeps
 * no other rule. A later step of the same run calls this from any process:
 * the session of the sandbox stays the same.
 */
export async function setRunVaultRules(
  access: AgentVaultAccess,
  runKey: string,
  rules: RunVaultRule[],
  options: { replace?: boolean } = {},
): Promise<void> {
  if (rules.length === 0 && !options.replace) return
  const { credentials, services } = servicesFor(rules)
  await asOwner(access, async (client) => {
    const vault = client.vault(runVaultName(runKey))
    await vault.credentials?.set(credentials)
    if (options.replace) await vault.services?.replaceAll(services)
    else await vault.services?.set(services)
  })
}

/**
 * Create the run's vault with `rules` and a proxy session for the sandbox.
 * Throws {@link AgentVaultUnavailableError} when Agent Vault does not answer.
 *
 * `unmatchedHosts` is what the proxy does with a request that no rule
 * matches: `passthrough` (the default) forwards it with no credential, and
 * `deny` refuses it with a 403. A rule with a path matches that exact path
 * only, so `deny` also refuses the other paths of a rule's host.
 */
export async function openRunVault(input: {
  access: AgentVaultAccess
  runKey: string
  ttlSeconds: number
  rules: RunVaultRule[]
  unmatchedHosts?: "passthrough" | "deny"
}): Promise<RunVault> {
  const { access } = input
  const name = runVaultName(input.runKey)
  const proxyAt = await proxyHost(access)
  const addRules = (rules: RunVaultRule[]) =>
    setRunVaultRules(access, input.runKey, rules)
  const close = async () => {
    await deleteRunVault(access, name).catch((error: unknown) =>
      log.warn({
        step: "agent-vault-run-close",
        message: `Deleting a run vault failed; the sweep deletes it: ${String(error)}`,
      }),
    )
  }
  await asOwner(access, async (client) => {
    try {
      await client.createVault({ name })
    } catch (error) {
      // A retry of the same run reuses its vault.
      if ((error as { status?: number }).status !== 409) throw error
    }
  })
  try {
    // The policy and the rules are in place before the session exists.
    if (input.unmatchedHosts)
      await setUnmatchedHostPolicy(access, name, input.unmatchedHosts)
    await addRules(input.rules)
    const session = await asOwner(access, async (client) =>
      client.vault(name).sessions?.create({ ttlSeconds: input.ttlSeconds }),
    )
    if (!session?.containerConfig)
      throw new AgentVaultUnavailableError(
        "Agent Vault has no TLS proxy (MITM is off)",
      )
    const { containerConfig } = session
    // The SDK names the proxy by the API's host; sandboxes dial `proxyAt` on
    // the port Agent Vault reports.
    const proxy = new URL(containerConfig.env.HTTPS_PROXY)
    proxy.hostname = proxyAt
    const proxied = buildProxyEnv(
      {
        ...containerConfig,
        env: {
          ...containerConfig.env,
          HTTPS_PROXY: proxy.href.replace(/\/$/, ""),
          HTTP_PROXY: proxy.href.replace(/\/$/, ""),
        },
      },
      SANDBOX_PROXY_CA_PATH,
    )
    return {
      name,
      caPem: containerConfig.caCertificate,
      addRules,
      close,
      env: {
        ...proxied,
        // curl reads only the lowercase name for `http://` targets.
        http_proxy: proxied.HTTP_PROXY ?? "",
        https_proxy: proxied.HTTPS_PROXY ?? "",
        no_proxy: proxied.NO_PROXY ?? "",
      },
    }
  } catch (error) {
    await close()
    throw unavailable(error)
  }
}

/**
 * Set what the vault's proxy does with a request that no rule matches, and
 * read the result back: an answer that does not confirm the policy fails
 * closed.
 */
async function setUnmatchedHostPolicy(
  access: AgentVaultAccess,
  name: string,
  policy: "passthrough" | "deny",
): Promise<void> {
  await asOwner(access, async (_client, token) => {
    const response = await avFetch(
      access,
      `/v1/vaults/${encodeURIComponent(name)}/settings`,
      { method: "PATCH", token, body: { unmatched_host_policy: policy } },
    )
    if (!response.ok || response.body.unmatched_host_policy !== policy)
      throw Object.assign(
        new AgentVaultUnavailableError(
          `Agent Vault did not set the unmatched host policy "${policy}" (${response.status})`,
        ),
        // A 401 makes `asOwner` log in again and retry.
        { status: response.status },
      )
  })
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
      return response.body as {
        vaults?: Array<{ name: string; created_at: string }>
      }
    })
    let deleted = 0
    for (const vault of listed.vaults ?? []) {
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

/** The shell command that writes the proxy CA into a sandbox. */
export function writeProxyCaCommand(caPem: string): string {
  return `mkdir -p "$(dirname ${SANDBOX_PROXY_CA_PATH})" && printf '%s\\n' '${caPem.trim().replace(/'/g, "")}' > ${SANDBOX_PROXY_CA_PATH}`
}

/** Write the proxy CA into a sandbox (before anything there uses the proxy). */
export async function writeProxyCa(
  handle: Pick<SandboxHandle, "process">,
  caPem: string,
): Promise<void> {
  const written = await handle.process.exec(writeProxyCaCommand(caPem))
  if (written.exitCode !== 0)
    throw new Error(`Writing the proxy CA failed: ${written.stderr}`)
}
