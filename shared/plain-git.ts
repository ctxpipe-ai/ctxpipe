import { mkdtempSync } from "node:fs"
import { BlockList, isIP } from "node:net"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"

/*
 * The plain git rules that the backend and codesearch share (CTX-815). The
 * backend checks a plain git URL and resolves its host
 * (`apps/backend/src/services/git/plain-git-remote.ts`). Each git read of
 * that remote, in the backend or in codesearch, then uses the environment
 * of this module. This module imports only Node built-ins, so both apps
 * (Node and Bun) can import it.
 */

/**
 * The address ranges that a hosted plain git host must not resolve to:
 * private, loopback, link-local (also cloud metadata), shared,
 * documentation, benchmark, multicast, and reserved ranges, for IPv4 and
 * IPv6. The IPv6 list also holds each range that contains an IPv4 address
 * (`::/96` IPv4-compatible, `::ffff:0:0/96` IPv4-mapped, and
 * `::ffff:0:0:0/96` IPv4-translated), so such a form is never public.
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
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
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
  return !BLOCKED_V6.check(address, "ipv6")
}

/**
 * The cloud metadata addresses: IPv4 link-local `169.254.0.0/16` (with
 * `169.254.169.254` and `169.254.170.2`), IPv6 link-local `fe80::/10`, the
 * IPv6 metadata address `fd00:ec2::254`, and each IPv6 form that contains a
 * `169.254.0.0/16` address (IPv4-mapped, IPv4-compatible, IPv4-translated,
 * and NAT64).
 */
const METADATA = new BlockList()
METADATA.addSubnet("169.254.0.0", 16, "ipv4")
for (const [network, prefix] of [
  ["fe80::", 10],
  ["fd00:ec2::254", 128],
  ["::ffff:169.254.0.0", 112],
  ["::169.254.0.0", 112],
  ["::ffff:0:169.254.0.0", 112],
  ["64:ff9b::169.254.0.0", 112],
] as const)
  METADATA.addSubnet(network, prefix, "ipv6")

/**
 * True when `address` is a cloud metadata address. A plain git read never
 * connects to one, also on self-host (CTO decision 2026-10-18). Each value
 * that is not an IP address counts as a metadata address.
 */
export function isMetadataAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return METADATA.check(address, "ipv4")
  if (family === 6) return METADATA.check(address, "ipv6")
  return true
}

/** What the deployment mode lets a plain git URL use. */
export type PlainGitRemotePolicy = {
  /** `http://` too, not only `https://` (self-host only). */
  http: boolean
  /** A host with private addresses (self-host only). */
  privateHosts: boolean
}

/**
 * A plain git remote that the backend checked: the URL that git reads, its
 * host and port, the addresses that the check saw, and the policy of the
 * check. The backend gives it to codesearch with each index request of a
 * repository that has no GitHub token.
 */
export type PinnedPlainGitRemote = {
  url: string
  host: string
  port: number
  addresses: string[]
  policy: PlainGitRemotePolicy
}

/** The address of an IP host (`10.0.0.5`, `[fd00::5]`), or null. */
export function ipLiteral(host: string): string | null {
  const bare = host.replace(/^\[(.*)\]$/, "$1")
  return isIP(bare) ? bare : null
}

/**
 * The reason why a git read must not use `remote`, or null. A second check
 * of a remote that the backend checked: codesearch runs it before each read,
 * so a fault in a request cannot send git to another scheme, host, or
 * address.
 */
export function pinnedPlainGitRemoteFault(
  remote: PinnedPlainGitRemote,
): string | null {
  let url: URL
  try {
    url = new URL(remote.url)
  } catch {
    return "The plain git URL is not a URL"
  }
  if (
    url.protocol !== "https:" &&
    !(remote.policy.http && url.protocol === "http:")
  )
    return "Plain git sources must use an https:// URL (http:// only on self-host). ssh, git:// and file:// are not supported."
  if (url.username || url.password || url.search || url.hash)
    return "A plain git URL must not have a user name, a password, a query, or a fragment"
  const port = Number(url.port) || (url.protocol === "http:" ? 80 : 443)
  if (url.hostname.toLowerCase() !== remote.host || port !== remote.port)
    return "The plain git URL does not match its checked host"
  if (!remote.addresses.length) return "The plain git host has no address"
  const literal = ipLiteral(remote.host)
  if (
    literal &&
    (remote.addresses.length !== 1 || remote.addresses[0] !== literal)
  )
    return "The plain git address does not match its IP host"
  if (remote.addresses.some(isMetadataAddress))
    return `The host ${remote.host} of the plain git URL resolves to a cloud metadata or link-local address`
  if (!remote.policy.privateHosts && !remote.addresses.every(isPublicAddress))
    return `The host ${remote.host} of the plain git URL resolves to a private, loopback, or link-local address`
  return null
}

/**
 * The only variables of the parent process that a plain git read keeps: the
 * program path, the temporary folder, the locale, and the TLS trust store.
 * Each other variable (a proxy, `GIT_SSL_NO_VERIFY`, a `GIT_CONFIG_*` of a
 * parent, a token) stays out. `HOME` is an empty folder
 * ({@link emptyHome}).
 */
const KEPT_VARIABLES = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
]

let home: string | undefined

/**
 * An empty home folder for each plain git read of this process. Curl reads
 * `~/.netrc`, so the home folder of the process user could send a
 * credential to a plain git host.
 */
function emptyHome(): string {
  home ??= mkdtempSync(join(tmpdir(), "ctxpipe-plain-git-home-"))
  return home
}

/**
 * The full git environment of one read of a checked plain git remote. Do
 * not merge it over `process.env`: it is the whole environment.
 *
 * - No credential and no prompt. Git reads no system or global config,
 *   and `HOME` is an empty folder, so curl reads no `.netrc` file.
 * - Only HTTPS, and also `http` when `allowHttp` is true (an `http://` URL
 *   on self-host). Never `ssh`, `git://`, or `file://`.
 * - No redirect.
 * - The host name connects only to the checked addresses
 *   (`http.curloptResolve`), so a new DNS answer cannot send git to another
 *   address. An IP host has no DNS answer to pin.
 * - A transfer that stays below 1 KiB/s for 60 seconds stops
 *   (`http.lowSpeedLimit`, `http.lowSpeedTime`). The caller also sets a time
 *   limit for the whole command and a size limit for each file.
 *
 * `extra` is git config that comes after the fixed config (tests only).
 */
export function plainGitRemoteEnvironment(
  remote: { host: string; port: number; addresses: readonly string[] },
  options: {
    allowHttp: boolean
    extra?: ReadonlyArray<readonly [string, string]>
    parent?: Record<string, string | undefined>
  },
): Record<string, string> {
  const config: Array<readonly [string, string]> = [
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ...(options.allowHttp ? [["protocol.http.allow", "always"] as const] : []),
    ["http.lowSpeedLimit", "1024"],
    ["http.lowSpeedTime", "60"],
    ...(ipLiteral(remote.host)
      ? []
      : [
          [
            "http.curloptResolve",
            `${remote.host}:${remote.port}:${remote.addresses
              .map((address) =>
                address.includes(":") ? `[${address}]` : address,
              )
              .join(",")}`,
          ] as const,
        ]),
    ...(options.extra ?? []),
  ]
  const parent = options.parent ?? process.env
  const env: Record<string, string> = {}
  for (const name of KEPT_VARIABLES) {
    const value = parent[name]
    if (value !== undefined) env[name] = value
  }
  Object.assign(env, {
    HOME: emptyHome(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: String(config.length),
  })
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}
