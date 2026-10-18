import { lookup as dnsLookup } from "node:dns/promises"
import {
  type CheckedPlainGitRemote,
  ipLiteral,
  isMetadataAddress,
  isPublicAddress,
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
 * must not resolve to a cloud metadata or link-local address. Git then
 * does its own DNS lookup, through the proxy of the operator if there is
 * one (self-host). Git follows no redirect. The Docker sandbox is different: it fetches through Agent
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
 * URL and the addresses that the check saw. A caller that must keep the
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
 * index request: the checked URL, and whether the deployment mode allows
 * `http://`. Codesearch reads a repository that has no GitHub token only
 * through it.
 */
export async function checkedPlainGitRemote(
  raw: string,
): Promise<CheckedPlainGitRemote> {
  const policy = plainGitUrlPolicy(plainGitDeployment())
  const remote = await resolvePlainGitRemote(raw, network.lookup, policy)
  return { url: remote.url, http: policy.http }
}

/**
 * The full git environment of one read of the checked plain git URL `url`
 * (the shared `plainGitRemoteEnvironment`): no credential and no prompt,
 * HTTPS only (also `http` for an `http://` URL when the policy of the
 * deployment mode allows it: self-host only), no redirect, no system or
 * global git config, a low-speed limit, and only a short list of the
 * variables of the backend process (the proxy, but no `GIT_SSL_NO_VERIFY`
 * and no `GIT_CONFIG_*`). It is the whole environment: do not merge it over
 * `process.env`. `extra` is the test config of {@link PlainGitNetwork}.
 */
export function plainGitRemoteEnvironment(
  url: string,
  extra: ReadonlyArray<readonly [string, string]> = [],
): Record<string, string> {
  return sharedPlainGitRemoteEnvironment({
    allowHttp:
      url.startsWith("http://") && plainGitUrlPolicy(plainGitDeployment()).http,
    extra,
  })
}

/** {@link resolvePlainGitRemote}, then its git environment. */
export async function plainGitRemote(
  raw: string,
): Promise<{ url: string; env: Record<string, string> }> {
  const { gitConfig } = network
  const remote = await resolvePlainGitRemote(raw)
  return {
    url: remote.url,
    env: plainGitRemoteEnvironment(remote.url, gitConfig),
  }
}

/** The default-branch tip of a plain git repository, or null. */
export async function resolvePlainGitTip(
  raw: string,
): Promise<{ sha: string; branch: string } | null> {
  const remote = await plainGitRemote(raw)
  return resolveGitRemoteTip({ url: remote.url, env: remote.env })
}
