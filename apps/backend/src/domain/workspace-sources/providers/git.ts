import { z } from "zod"
import { normalizeWorkspaceRepositoryUrl } from "../../workspaces/slug.js"
import { githubRepositoryUrls } from "./github.js"
import type { SourceScopeDefinition } from "./scope.js"

/*
 * A plain git source (CTX-815): a repository that ctx| reads with git over
 * public HTTPS, with no connection and no credential. On main, an operator
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
  /** `https://<host><path>`: the URL that git fetches. */
  url: string
  /** The host name, in lower case, with no port. */
  host: string
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

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/

/**
 * Check a plain git URL with the rules that need no network: HTTPS, no
 * user name or password, the default port, no query or fragment, a host
 * name (not an IP address) that is not a private name, and a simple path.
 * A redirect is never followed, so a redirect cannot go around these rules.
 */
export function checkPlainGitUrl(raw: string): PlainGitUrlCheck {
  const refuse = (rule: PlainGitUrlRule, reason: string): PlainGitUrlCheck => ({
    ok: false,
    rule,
    reason,
  })
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return refuse("not_a_url", "The git URL is not a URL")
  }
  if (url.protocol !== "https:")
    return refuse("not_https", "A plain git URL must use HTTPS")
  if (url.username || url.password)
    return refuse(
      "userinfo",
      "A plain git URL must not have a user name or a password",
    )
  // The URL parser removes the default port (443), so each port is another.
  if (url.port)
    return refuse("port", "A plain git URL must use the default HTTPS port")
  if (url.search || url.hash || raw.includes("?") || raw.includes("#"))
    return refuse(
      "query",
      "A plain git URL must not have a query or a fragment",
    )
  const host = url.hostname.toLowerCase()
  // The URL parser writes each IPv4 form (also hex and integer forms) as
  // dotted digits, and each IPv6 address in brackets.
  if (host.startsWith("[") || /^[0-9.]+$/.test(host))
    return refuse(
      "ip_address",
      "A plain git URL must use a host name, not an IP address",
    )
  const labels = host.split(".")
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    return refuse(
      "private_host",
      "A plain git URL must use a public host name with a domain",
    )
  if (PRIVATE_NAME_SUFFIXES.includes(labels.at(-1) ?? ""))
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
  return { ok: true, url: `https://${host}${path}`, host, path }
}

/** The Zod schema of a plain git URL: {@link checkPlainGitUrl}. */
export const plainGitUrlSchema = z.string().superRefine((value, ctx) => {
  const checked = checkPlainGitUrl(value)
  if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.reason })
})

/** The scope of a plain git source file: one public HTTPS git URL. */
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
 * The plain git URL of a source scope in its checked form (`https://<host>`
 * in lower case, then the path), or null when it does not parse.
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
