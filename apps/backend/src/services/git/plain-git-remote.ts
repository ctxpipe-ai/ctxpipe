import { lookup as dnsLookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import {
  checkPlainGitUrl,
  type PlainGitUrl,
  type PlainGitUrlRule,
} from "../../domain/workspace-sources/providers/git.js"
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
 * Check a plain git URL with every rule: the URL rules of
 * {@link checkPlainGitUrl}, then the DNS rule. Each address of the host must
 * be public. Returns the URL and the addresses that git must use.
 */
export async function resolvePlainGitRemote(
  raw: string,
  lookup: PlainGitLookup = systemLookup,
): Promise<PlainGitUrl & { addresses: string[] }> {
  const checked = checkPlainGitUrl(raw)
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
  if (!addresses.every(isPublicAddress))
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
 * the checked addresses.
 */
export function plainGitRemoteEnvironment(remote: {
  host: string
  addresses: readonly string[]
}): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = [
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    [
      "http.curloptResolve",
      `${remote.host}:443:${remote.addresses
        .map((address) => (address.includes(":") ? `[${address}]` : address))
        .join(",")}`,
    ],
  ]
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
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
  lookup?: PlainGitLookup,
): Promise<{ url: string; env: NodeJS.ProcessEnv }> {
  const remote = await resolvePlainGitRemote(raw, lookup)
  return { url: remote.url, env: plainGitRemoteEnvironment(remote) }
}

/** The default-branch tip of a plain git repository, or null. */
export async function resolvePlainGitTip(
  raw: string,
): Promise<{ sha: string; branch: string } | null> {
  const remote = await plainGitRemote(raw)
  return resolveGitRemoteTip({ url: remote.url, env: remote.env })
}
