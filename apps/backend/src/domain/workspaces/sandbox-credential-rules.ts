import { createHash } from "node:crypto"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * The credentials that something outside a chat sandbox adds to its
 * requests: the Vercel firewall (hosted) or Agent Vault (Docker). One list,
 * so both add the same header to the same requests.
 *
 * A rule with a path matches that exact path only. The backend resolves `..`
 * and `%2e` segments before it routes a request, so a prefix match could
 * send a credential to another route. Each renderer also pins the `Host`
 * header to the rule's host.
 */
export type SandboxCredentialRule = {
  name: string
  /** A host name, with a port when it is not the scheme's default. */
  host: string
  /** An exact path; without it, every path of the host. */
  path?: string
  /** The whole `Authorization` header value. */
  authorization: string
}

/** GitHub hosts with the read token: Basic for Git, Bearer for the REST API. */
export function githubCredentialRules(token: string): SandboxCredentialRule[] {
  const basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  return [
    { name: "github-git", host: "github.com", authorization: basic },
    {
      name: "github-codeload",
      host: "codeload.github.com",
      authorization: basic,
    },
    {
      name: "github-api",
      host: "api.github.com",
      authorization: `Bearer ${token}`,
    },
  ]
}

/**
 * Git fetch only, for a vault that refuses requests with no rule (ingest):
 * `info/refs` and `git-upload-pack` of each repository (`owner/name`, as the
 * sandbox writes it in a `https://<host>/<owner>/<name>.git` URL). With no
 * rule for `git-receive-pack` or the REST API, the proxy refuses a push and
 * each API call. Agent Vault matches the path without the query, so the
 * `info/refs` rule also covers `?service=git-receive-pack`; that call only
 * lists refs.
 */
export function githubFetchCredentialRules(
  token: string,
  repositories: string[],
  host = "github.com",
): SandboxCredentialRule[] {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  return repositories.flatMap((repository) =>
    ["info/refs", "git-upload-pack"].map((path) => ({
      // A service name is a short slug; the hash keeps it unique.
      name: `git-fetch-${createHash("sha256").update(`${host}/${repository}/${path}`).digest("hex").slice(0, 16)}`,
      host,
      path: `/${repository}.git/${path}`,
      authorization,
    })),
  )
}

/**
 * The URL that an ingest sandbox fetches a shard repository from. A GitHub
 * repository gets `https://github.com/<owner>/<name>.git`: the egress rules
 * of {@link githubFetchCredentialRules} match only the paths of this URL, so
 * a normalized Workspace URL (with no `.git`) gets a 403 from the proxy. A
 * plain git source keeps its URL: its rules match the path of that URL
 * (CTX-815).
 */
export function sandboxFetchUrl(repo: { url: string; kind?: string }): string {
  if (repo.kind === "git") return repo.url
  const fullName = githubRepoFullNameFromWorkspaceUrl(repo.url)
  if (!fullName) throw new Error("Ingest repositories must be on GitHub")
  return `https://github.com/${fullName}.git`
}

/** One public plain git repository: its host and its path (CTX-815). */
export type PlainGitRepository = { host: string; path: string }

/**
 * Git fetch only of one public plain git repository, with no credential
 * (CTX-815): `info/refs` and `git-upload-pack` below the repository path,
 * the paths that git requests for `https://<host><path>`. As for GitHub,
 * no rule allows `git-receive-pack`, so a push is refused.
 */
export function plainGitFetchRules(
  repository: PlainGitRepository,
): Array<Omit<SandboxCredentialRule, "authorization">> {
  return ["info/refs", "git-upload-pack"].map((path) => ({
    name: `git-plain-${createHash("sha256").update(`${repository.host}${repository.path}/${path}`).digest("hex").slice(0, 16)}`,
    host: repository.host,
    path: `${repository.path}/${path}`,
  }))
}

/** A Bearer token on one exact URL (host and path). */
export function bearerUrlRule(
  name: string,
  url: string,
  token: string,
): SandboxCredentialRule {
  const parsed = new URL(url)
  return {
    name,
    host: parsed.host,
    path: parsed.pathname,
    authorization: `Bearer ${token}`,
  }
}

/** The model proxy's two routes, from its base URL (`…/openai/v1`). */
export function modelProxyCredentialRules(
  proxyUrl: string,
  capability: string,
): SandboxCredentialRule[] {
  const base = proxyUrl.replace(/\/$/, "")
  return [
    bearerUrlRule("model-proxy-chat", `${base}/chat/completions`, capability),
    bearerUrlRule("model-proxy-models", `${base}/models`, capability),
  ]
}
