import { lookup as dnsLookup } from "node:dns/promises"
import https from "node:https"
import { isIP } from "node:net"
import { Readable } from "node:stream"
import {
  ipLiteral,
  isMetadataAddress,
  isPublicAddress,
  type PinnedPlainGitRemote,
  plainGitRemoteEnvironment as sharedPlainGitRemoteEnvironment,
} from "../../../../../shared/plain-git.js"
import {
  checkPlainGitUrl,
  type PlainGitUrl,
  type PlainGitUrlPolicy,
  type PlainGitUrlRule,
  plainGitDeployment,
  plainGitSchemeRule,
  plainGitUrlPolicy,
} from "../../domain/workspace-sources/providers/git.js"
import { resolveGitRemoteTip } from "./clone-tree.js"

export { isMetadataAddress, isPublicAddress }

/*
 * The backend side of a plain git source (CTX-815). ctx| reads the
 * repository with no credential. Before each read, the host must obey the
 * URL policy of the deployment mode (`plainGitUrlPolicy`). Hosted: the
 * host name must resolve only to public addresses. Self-host: the host
 * must not resolve to a cloud metadata or link-local address. Each git
 * read of the backend and of codesearch connects only to the addresses
 * that this check saw (`http.curloptResolve`), so a DNS answer that changes
 * after the check cannot send git to another address. Git follows no
 * redirect. The Docker sandbox is different: it fetches through Agent
 * Vault, which does its own DNS lookup (see `ingest-sandbox-egress.ts`).
 */

/** A plain git URL that ctx| does not read, with the rule that refused it. */
export class PlainGitUrlError extends Error {
  constructor(
    readonly rule:
      | PlainGitUrlRule
      | "private_address"
      | "metadata_address"
      | "no_address",
    message: string,
  ) {
    super(message)
    this.name = "PlainGitUrlError"
  }
}

/**
 * The reason of a refused plain git URL, as a person reads it: the message
 * of the rule, then the protocol rule of the deployment mode, if the
 * message does not state it yet. The repositories route and the upgrade
 * report show it.
 */
export function plainGitRefusalReason(
  error: PlainGitUrlError,
  policy: PlainGitUrlPolicy = plainGitUrlPolicy(plainGitDeployment()),
): string {
  const schemes = plainGitSchemeRule(policy)
  return error.message.includes(schemes)
    ? error.message
    : `${error.message.replace(/\.$/, "")}. ${schemes}`
}

/** A DNS lookup of all addresses of a host name. */
export type PlainGitLookup = (
  host: string,
) => Promise<ReadonlyArray<{ address: string }>>

const systemLookup: PlainGitLookup = (host) =>
  dnsLookup(host, { all: true, verbatim: true })

/** The limits of one host fetch of a plain git source. */
export type PlainGitFetchLimits = {
  /** The time limit of one git command; then the backend kills git. */
  timeoutMs: number
  /** The size limit of each file that git writes (the pack). */
  maxFileBytes: number
}

/**
 * How the backend reaches a plain git host: the DNS lookup, git config that
 * each host read adds after the fixed config, and the limits of a host
 * fetch. Production uses the system resolver, adds nothing, and uses the
 * default limits. A test gives its own DNS answers
 * ({@link usePlainGitNetwork}), can send a host to a local repository
 * (`url.<folder>.insteadOf`), and can make the limits small.
 */
export type PlainGitNetwork = {
  lookup: PlainGitLookup
  gitConfig?: ReadonlyArray<readonly [string, string]>
  limits?: Partial<PlainGitFetchLimits>
}

let network: PlainGitNetwork = { lookup: systemLookup }

/**
 * Tests only: the DNS answers, the git config, and the limits of each plain
 * git host read of this process (the environment of the test, as
 * `vi.stubEnv` is for env). Returns the function that puts the system
 * resolver back.
 */
export function usePlainGitNetwork(next: PlainGitNetwork): () => void {
  network = next
  return () => {
    network = { lookup: systemLookup }
  }
}

/**
 * The limits of one host fetch of a plain git source: 10 minutes for each
 * git command, and 2 GiB for each file that git writes.
 */
export function plainGitFetchLimits(): PlainGitFetchLimits {
  return {
    timeoutMs: 10 * 60_000,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    ...network.limits,
  }
}

/**
 * Check a plain git URL with every rule of the deployment's policy
 * ({@link plainGitUrlPolicy}): the URL rules of {@link checkPlainGitUrl},
 * then the DNS rule. Unless the policy allows private hosts, each address
 * of the host must be public. In each mode, no address can be a cloud
 * metadata or link-local address ({@link isMetadataAddress}). Returns the
 * URL and the addresses that git must use. A caller that must keep the
 * strict rule in each mode (the hosted egress proxy) gives the hosted
 * policy.
 */
export async function resolvePlainGitRemote(
  raw: string,
  lookup: PlainGitLookup = network.lookup,
  policy: PlainGitUrlPolicy = plainGitUrlPolicy(plainGitDeployment()),
): Promise<PlainGitUrl & { addresses: string[] }> {
  const checked = checkPlainGitUrl(raw, policy)
  if (!checked.ok) throw new PlainGitUrlError(checked.rule, checked.reason)
  // An IP host (self-host only) is its own address: no DNS lookup.
  const literal = ipLiteral(checked.host)
  let answers: ReadonlyArray<{ address: string }>
  try {
    answers = literal ? [{ address: literal }] : await lookup(checked.host)
  } catch {
    answers = []
  }
  const addresses = [...new Set(answers.map((answer) => answer.address))]
  // Hosted: one message for a host with no address and a host with a
  // private address, so that a URL cannot show which internal names exist.
  const noPublicAddress = `The host ${checked.host} of the plain git URL has no public address`
  if (!addresses.length)
    throw new PlainGitUrlError(
      "no_address",
      policy.privateHosts
        ? `The host ${checked.host} of the plain git URL has no address`
        : noPublicAddress,
    )
  if (!policy.privateHosts && !addresses.every(isPublicAddress))
    throw new PlainGitUrlError("private_address", noPublicAddress)
  if (addresses.some(isMetadataAddress))
    throw new PlainGitUrlError(
      "metadata_address",
      `The host ${checked.host} of the plain git URL resolves to a cloud metadata or link-local address`,
    )
  const { ok: _ok, ...url } = checked
  return { ...url, addresses }
}

/**
 * {@link resolvePlainGitRemote} in the form that codesearch takes in an
 * index request: the checked URL, its host, port, and addresses, and the
 * policy of the check. Codesearch reads a repository that has no GitHub
 * token only through it.
 */
export async function pinnedPlainGitRemote(
  raw: string,
): Promise<PinnedPlainGitRemote> {
  const policy = plainGitUrlPolicy(plainGitDeployment())
  const remote = await resolvePlainGitRemote(raw, network.lookup, policy)
  return {
    url: remote.url,
    host: remote.host,
    port: remote.port,
    addresses: remote.addresses,
    policy: { http: policy.http, privateHosts: policy.privateHosts },
  }
}

/**
 * The full git environment of one read of a checked plain git remote (the
 * shared `plainGitRemoteEnvironment`): no credential and no prompt, HTTPS
 * only (also `http` for an `http://` URL when the policy of the deployment
 * mode allows it: self-host only), no redirect, a host name pinned to the
 * checked addresses, no system or global git config, a low-speed limit, and
 * only a short list of the variables of the backend process (no proxy, no
 * `GIT_SSL_NO_VERIFY`, no `GIT_CONFIG_*`). It is the whole environment: do
 * not merge it over `process.env`. `extra` is the test config of
 * {@link PlainGitNetwork}.
 */
export function plainGitRemoteEnvironment(
  remote: {
    url?: string
    host: string
    port?: number
    addresses: readonly string[]
  },
  extra: ReadonlyArray<readonly [string, string]> = [],
): Record<string, string> {
  return sharedPlainGitRemoteEnvironment(
    {
      host: remote.host,
      port: remote.port ?? 443,
      addresses: remote.addresses,
    },
    {
      allowHttp:
        remote.url?.startsWith("http://") === true &&
        plainGitUrlPolicy(plainGitDeployment()).http,
      extra,
    },
  )
}

/** {@link resolvePlainGitRemote}, then its git environment. */
export async function plainGitRemote(
  raw: string,
): Promise<{ url: string; env: Record<string, string> }> {
  const { gitConfig } = network
  const remote = await resolvePlainGitRemote(raw)
  return { url: remote.url, env: plainGitRemoteEnvironment(remote, gitConfig) }
}

/** The default-branch tip of a plain git repository, or null. */
export async function resolvePlainGitTip(
  raw: string,
): Promise<{ sha: string; branch: string } | null> {
  const remote = await plainGitRemote(raw)
  return resolveGitRemoteTip({ url: remote.url, env: remote.env })
}

/**
 * One HTTPS request to a checked plain git host that connects only to
 * `addresses` (the addresses of the check), never to a new DNS answer. Git
 * smart HTTP reads only: the hosted egress proxy sends each one here. It
 * uses `node:https` with a pinned `lookup` and no pooled socket, because
 * Bun's `fetch` does not take an undici dispatcher; Bun calls this `lookup`
 * (see `verifyConnectorAssetRuntime.ts`). It follows no redirect: the
 * caller gets the 3xx answer. `ca` and `port` are for a test server only.
 */
export function plainGitPinnedRequest(input: {
  url: URL
  method: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  addresses: readonly string[]
  ca?: string
  port?: number
}): Promise<Response> {
  const pinned = input.addresses.map((address) => ({
    address,
    family: (isIP(address) === 6 ? 6 : 4) as 4 | 6,
  }))
  const first = pinned[0]
  if (!first) return Promise.reject(new Error("No checked address to connect"))
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: input.url.hostname,
        port: input.port ?? 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: Object.fromEntries(input.headers),
        // A pooled keep-alive socket never calls `lookup`, so it would skip
        // the pin.
        agent: false,
        servername: input.url.hostname,
        rejectUnauthorized: true,
        ...(input.ca ? { ca: input.ca } : {}),
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all)
            (callback as (e: null, all: typeof pinned) => void)(null, pinned)
          else callback(null, first.address, first.family)
        },
      },
      (response) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers))
          for (const one of Array.isArray(value) ? value : [value])
            if (one !== undefined) headers.append(name, one)
        const status = response.statusCode ?? 0
        if (status < 200 || status > 599) {
          response.destroy()
          reject(new Error(`The plain git host answered ${status}`))
          return
        }
        const empty = [204, 205, 304].includes(status)
        if (empty) response.resume()
        resolve(
          new Response(
            empty
              ? null
              : (Readable.toWeb(
                  response,
                ) as unknown as ReadableStream<Uint8Array>),
            { status, statusText: response.statusMessage ?? "", headers },
          ),
        )
      },
    )
    req.setTimeout(60_000, () =>
      req.destroy(new Error("The plain git host did not answer in time")),
    )
    req.on("error", reject)
    if (input.body) Readable.fromWeb(input.body as never).pipe(req)
    else req.end()
  })
}
