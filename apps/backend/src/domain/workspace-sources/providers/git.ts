import { z } from "zod"
import { normalizeWorkspaceRepositoryUrl } from "../../workspaces/slug.js"
import { githubRepositoryUrls } from "./github.js"
import type { SourceScopeDefinition } from "./scope.js"

/*
 * A plain git source (CTX-815): a repository that ctx| reads with git over
 * HTTP(S), with no connection and no credential ({@link plainGitUrlPolicy}). On main, an operator
 * added such a repository with `POST /v1/repositories` and the old ingestion
 * cloned it with no token. A source file `sources/git/<host>/<name>.md`
 * links it to a Workspace.
 *
 * This module imports only `zod` and the URL normalizer, so the UI can
 * import it too. The DNS check of the host is in the backend
 * (`services/git/plain-git-remote.ts`).
 */

/** The rule that refused a plain git URL. */
export type PlainGitUrlRule =
  | "not_a_url"
  | "not_https"
  | "userinfo"
  | "port"
  | "query"
  | "ip_address"
  | "private_host"
  | "path"

export type PlainGitUrl = {
  /** `https://<host><path>` (or `http://`, with a port): the URL that git fetches. */
  url: string
  /** The host name, in lower case, with no port. */
  host: string
  /** The port that git connects to: the URL's port, or 443 (80 for `http`). */
  port: number
  /** The repository path, with no `/` at the end (`/team/app.git`). */
  path: string
}

export type PlainGitUrlCheck =
  | ({ ok: true } & PlainGitUrl)
  | { ok: false; rule: PlainGitUrlRule; reason: string }

/**
 * Names that resolve only inside a private network. The DNS check of the
 * backend refuses each other name that resolves to a private address.
 */
const PRIVATE_NAME_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "arpa",
]

/** Where ctx| runs: ctx| runs the service (`hosted`), or a customer does. */
export type PlainGitDeployment = "hosted" | "self-host"

/**
 * The deployment mode of the plain git URL policy. Only
 * `SANDBOX_PROVIDER=docker` is self-host. Spaces around the value are
 * removed, as `lockedSandboxProvider` does. Each other value
 * (`vercel`, `unsandboxed`, or no value) gets the strict rule of hosted.
 * The UI has no `process`, so this function gives the strict rule there.
 * The UI does not use it to judge a plain git URL: the UI has no editor
 * for a plain git source, and the backend is the only judge. The UI shows
 * the status and the error that the backend gives for each source.
 */
export function plainGitDeployment(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): PlainGitDeployment {
  return env.SANDBOX_PROVIDER?.trim() === "docker" ? "self-host" : "hosted"
}

/** What a plain git URL may use. */
export type PlainGitUrlPolicy = {
  /** `http://` too, not only `https://`. */
  http: boolean
  /** A port that is not the default port of the scheme. */
  otherPorts: boolean
  /** An IP host, a private name, and a host with private addresses. */
  privateHosts: boolean
}

/**
 * The plain git URL policy of one deployment mode: the one place that
 * decides it.
 *
 * - Hosted: HTTPS, the default port, and a public host only. The host must
 *   not be an IP address or a private name, and each of its addresses must
 *   be public.
 * - Self-host (Docker): the customer runs ctx| inside its own network, as
 *   on main. A URL may use `http://`, another port, an IP address, a
 *   private name, and a host with private addresses. The host must not
 *   resolve to a cloud metadata or link-local address (169.254.0.0/16,
 *   fe80::/10, fd00:ec2::254): the DNS check of the backend refuses it.
 *
 * In each mode, the read stays a Git smart HTTP read (`info/refs` and
 * `git-upload-pack`) with no credential and no redirect, and git never
 * uses `ssh`, `git://`, or `file://`: the sandbox reaches the outside only
 * through an HTTP proxy. A git read of the backend or of codesearch
 * connects only to the checked addresses. The Docker sandbox fetch is not
 * pinned: Agent Vault resolves the host name again when it connects.
 */
export function plainGitUrlPolicy(
  deployment: PlainGitDeployment,
): PlainGitUrlPolicy {
  const selfHost = deployment === "self-host"
  return { http: selfHost, otherPorts: selfHost, privateHosts: selfHost }
}

/** The scheme rule as a person reads it, for each message about the scheme. */
export function plainGitSchemeRule(
  policy: PlainGitUrlPolicy = plainGitUrlPolicy(plainGitDeployment()),
): string {
  return `Plain git sources must use ${policy.http ? "an http:// or https://" : "an https://"} URL. ssh (git@… or ssh://), git:// and file:// are not supported.`
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/

/**
 * Check a plain git URL with the rules that need no network: HTTPS (also
 * `http` when `policy` allows it), no user name or password, the default
 * port (or another, when `policy` allows it), no query or fragment, a host
 * name (not an IP address) that is not a private name (unless `policy`
 * allows private hosts), and a simple path. The default policy is the
 * policy of this process's deployment mode ({@link plainGitDeployment}). A
 * redirect is never followed, so a redirect cannot go around these rules.
 */
export function checkPlainGitUrl(
  raw: string,
  policy: PlainGitUrlPolicy = plainGitUrlPolicy(plainGitDeployment()),
): PlainGitUrlCheck {
  const refuse = (rule: PlainGitUrlRule, reason: string): PlainGitUrlCheck => ({
    ok: false,
    rule,
    reason,
  })
  const schemes = plainGitSchemeRule(policy)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return refuse("not_a_url", `The git URL is not a URL. ${schemes}`)
  }
  if (url.protocol !== "https:" && !(policy.http && url.protocol === "http:"))
    return refuse("not_https", schemes)
  if (url.username || url.password)
    return refuse(
      "userinfo",
      "A plain git URL must not have a user name or a password",
    )
  // The URL parser removes the default port of the scheme (443, or 80 for
  // `http`), so each port is another.
  if (url.port && !policy.otherPorts)
    return refuse("port", "A plain git URL must use the default HTTPS port")
  if (url.search || url.hash || raw.includes("?") || raw.includes("#"))
    return refuse(
      "query",
      "A plain git URL must not have a query or a fragment",
    )
  const host = url.hostname.toLowerCase()
  // The URL parser writes each IPv4 form (also hex and integer forms) as
  // dotted digits, and each IPv6 address in brackets.
  const ipHost = host.startsWith("[") || /^[0-9.]+$/.test(host)
  if (!policy.privateHosts && ipHost)
    return refuse(
      "ip_address",
      "A plain git URL must use a host name, not an IP address",
    )
  const labels = host.split(".")
  if (
    !ipHost &&
    ((!policy.privateHosts && labels.length < 2) ||
      !labels.every((label) => LABEL.test(label)))
  )
    return refuse(
      "private_host",
      policy.privateHosts
        ? "A plain git URL must use a valid host name"
        : "A plain git URL must use a public host name with a domain",
    )
  if (
    !policy.privateHosts &&
    PRIVATE_NAME_SUFFIXES.includes(labels.at(-1) ?? "")
  )
    return refuse(
      "private_host",
      `A plain git URL must not use a private host name (.${labels.at(-1)})`,
    )
  const path = url.pathname.replace(/\/$/, "")
  const segments = path.split("/").slice(1)
  if (
    path.length > 300 ||
    raw.includes("%") ||
    segments.length === 0 ||
    !segments.every(
      (segment) =>
        PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    )
  )
    return refuse(
      "path",
      "A plain git URL must have a repository path of letters, digits, '.', '_', '~', and '-'",
    )
  return {
    ok: true,
    url: `${url.protocol}//${url.host}${path}`,
    host,
    port: Number(url.port) || (url.protocol === "http:" ? 80 : 443),
    path,
  }
}

/** The Zod schema of a plain git URL: {@link checkPlainGitUrl}. */
export const plainGitUrlSchema = z.string().superRefine((value, ctx) => {
  const checked = checkPlainGitUrl(value)
  if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.reason })
})

/** The scope of a plain git source file: one plain git URL. */
export const gitFileScopeSchema = z.strictObject({ url: plainGitUrlSchema })

export type GitFileScope = z.infer<typeof gitFileScopeSchema>

/** The scope of a plain git source file under `sources/git/`. */
export const gitSourceScope: SourceScopeDefinition = {
  connectionType: null,
  label: "Git",
  schema: gitFileScopeSchema,
  summarize: (scope) => gitFileScopeSchema.parse(scope).url,
}

/**
 * The plain git URL of a source scope in its checked form (the scheme, the
 * host in lower case and its port, then the path), or null when it does not
 * parse.
 */
export function gitSourceScopeUrl(scope: unknown): string | null {
  const parsed = gitFileScopeSchema.safeParse(scope)
  if (!parsed.success) return null
  const checked = checkPlainGitUrl(parsed.data.url)
  return checked.ok ? checked.url : null
}

/**
 * The name of a source repository in reports and in the re-ingestion list:
 * `owner/name` for GitHub, and `<host>/<path>` (with no `.git` at the end)
 * for each other host.
 */
export function sourceRepositoryName(url: string): string {
  const normalized = normalizeWorkspaceRepositoryUrl(url)
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(normalized)
  return github?.[1] ?? normalized.replace(/^[a-z]+:\/\//, "")
}

/**
 * The normalized repository URLs of a source or a stored target that names
 * repositories: a GitHub source or a plain git source. A source of another
 * provider, or a scope that does not parse, gives none.
 */
export function sourceRepositoryUrls(source: {
  provider: string | null
  scope: unknown
}): string[] {
  if (source.provider === "git") {
    const url = gitSourceScopeUrl(source.scope)
    return url ? [normalizeWorkspaceRepositoryUrl(url)] : []
  }
  return githubRepositoryUrls(source)
}
