import { lookup as dnsLookup } from "node:dns/promises"
import https from "node:https"
import { BlockList, isIP } from "node:net"
import { devNull } from "node:os"
import { Readable } from "node:stream"
import {
  checkPlainGitUrl,
  type PlainGitDeployment,
  type PlainGitUrl,
  type PlainGitUrlRule,
  plainGitUrlPolicy,
} from "../../domain/workspace-sources/providers/git.js"
import { lockedSandboxProvider } from "../../domain/workspaces/sandbox-provider.js"
import { resolveGitRemoteTip } from "./clone-tree.js"

/*
 * The backend side of a plain git source (CTX-815). ctx| reads the
 * repository over public HTTPS with no credential. Before each read, the
 * host name must resolve only to public addresses, and git connects to the
 * addresses that this check saw (`http.curloptResolve`), so a DNS answer
 * that changes after the check cannot send git to a private address. Git
 * follows no redirect.
 */

/** A plain git URL that ctx| does not read, with the rule that refused it. */
export class PlainGitUrlError extends Error {
  constructor(
    readonly rule: PlainGitUrlRule | "private_address" | "no_address",
    message: string,
  ) {
    super(message)
    this.name = "PlainGitUrlError"
  }
}

/**
 * The address ranges that a plain git host must not resolve to: private,
 * loopback, link-local (also cloud metadata), shared, documentation,
 * benchmark, multicast, and reserved ranges, for IPv4 and IPv6. One list
 * for each family: a `BlockList` also matches an IPv4 address against the
 * IPv4-mapped IPv6 ranges.
 */
const BLOCKED_V4 = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED_V4.addSubnet(network, prefix, "ipv4")
const BLOCKED_V6 = new BlockList()
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED_V6.addSubnet(network, prefix, "ipv6")

/** True when `address` (an IPv4 or IPv6 address) is a public address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !BLOCKED_V4.check(address, "ipv4")
  if (family !== 6) return false
  // An IPv6 form of an IPv4 address (`::ffff:a.b.c.d`) is never public here.
  if (/^::ffff:/i.test(address)) return false
  return !BLOCKED_V6.check(address, "ipv6")
}

/** A DNS lookup of all addresses of a host name. */
export type PlainGitLookup = (
  host: string,
) => Promise<ReadonlyArray<{ address: string }>>

const systemLookup: PlainGitLookup = (host) =>
  dnsLookup(host, { all: true, verbatim: true })

/**
 * How the backend reaches a plain git host: the DNS lookup, and git config
 * that each host read adds after the fixed config. Production uses the
 * system resolver and adds nothing. A test gives its own DNS answers
 * ({@link usePlainGitNetwork}), and can send a host to a local repository
 * (`url.<folder>.insteadOf`).
 */
export type PlainGitNetwork = {
  lookup: PlainGitLookup
  gitConfig?: ReadonlyArray<readonly [string, string]>
}

let network: PlainGitNetwork = { lookup: systemLookup }

/**
 * Tests only: the DNS answers and the git config of each plain git host read
 * of this process (the environment of the test, as `vi.stubEnv` is for env).
 * Returns the function that puts the system resolver back.
 */
export function usePlainGitNetwork(next: PlainGitNetwork): () => void {
  network = next
  return () => {
    network = { lookup: systemLookup }
  }
}

/** The deployment mode: hosted runs Vercel sandboxes, self-host Docker. */
export function plainGitDeployment(
  env: Record<string, string | undefined> = process.env,
): PlainGitDeployment {
  return lockedSandboxProvider(env) === "vercel" ? "hosted" : "self-host"
}

/**
 * Check a plain git URL with every rule of the deployment's policy
 * ({@link plainGitUrlPolicy}): the URL rules of {@link checkPlainGitUrl},
 * then the DNS rule. Each address of the host must be public. Returns the
 * URL and the addresses that git must use.
 */
export async function resolvePlainGitRemote(
  raw: string,
  lookup: PlainGitLookup = network.lookup,
): Promise<PlainGitUrl & { addresses: string[] }> {
  const policy = plainGitUrlPolicy(plainGitDeployment())
  const checked = checkPlainGitUrl(raw, policy)
  if (!checked.ok) throw new PlainGitUrlError(checked.rule, checked.reason)
  let answers: ReadonlyArray<{ address: string }>
  try {
    answers = await lookup(checked.host)
  } catch {
    answers = []
  }
  const addresses = [...new Set(answers.map((answer) => answer.address))]
  if (!addresses.length)
    throw new PlainGitUrlError(
      "no_address",
      `The host ${checked.host} of the plain git URL has no address`,
    )
  if (!policy.privateHosts && !addresses.every(isPublicAddress))
    throw new PlainGitUrlError(
      "private_address",
      `The host ${checked.host} of the plain git URL resolves to a private, loopback, or link-local address`,
    )
  const { ok: _ok, ...url } = checked
  return { ...url, addresses }
}

/**
 * The git environment of one read of a checked plain git remote: no
 * credential and no prompt, HTTPS only, no redirect, and the host pinned to
 * the checked addresses. Git reads no system or global config, and no
 * config from a `git -c` of a parent process: a credential helper or an
 * `http.extraHeader` there cannot send a credential to the plain git host.
 * `extra` is the test config of {@link PlainGitNetwork}.
 */
export function plainGitRemoteEnvironment(
  remote: { host: string; port?: number; addresses: readonly string[] },
  extra: ReadonlyArray<readonly [string, string]> = [],
): NodeJS.ProcessEnv {
  const config: Array<readonly [string, string]> = [
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    [
      "http.curloptResolve",
      `${remote.host}:${remote.port ?? 443}:${remote.addresses
        .map((address) => (address.includes(":") ? `[${address}]` : address))
        .join(",")}`,
    ],
    ...extra,
  ]
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_PARAMETERS: "",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

/** {@link resolvePlainGitRemote}, then its git environment. */
export async function plainGitRemote(
  raw: string,
): Promise<{ url: string; env: NodeJS.ProcessEnv }> {
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
