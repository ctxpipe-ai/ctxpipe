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
