import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { defineSandboxProxy, type ProxyMeta } from "@vercel/sandbox/proxy"
import { decodeJwt } from "jose"
import { log } from "../../observability/logger.js"
import {
  type PlainGitLookup,
  resolvePlainGitRemote,
} from "../../services/git/plain-git-remote.js"
import { plainGitUrlPolicy } from "../workspace-sources/providers/git.js"
import type { IngestGitAccess } from "./ingest-sandbox-egress.js"
import {
  bearerUrlRule,
  githubFetchCredentialRules,
  modelProxyCredentialRules,
  type PlainGitRepository,
  plainGitFetchRules,
  type SandboxCredentialRule,
} from "./sandbox-credential-rules.js"
import {
  type HostedTurnCredentials,
  vercelOidcIssuer,
} from "./vercel-sandbox-provider.js"

/**
 * The backend egress proxy of hosted (Vercel) ingest sandboxes (ADR-052).
 * The sandbox firewall forwards each request to `github.com` and to the
 * backend host to `<backend>/api/v1/sandbox-egress/<sealed scope>`. The
 * sealed scope holds what the shard may reach and its credentials, so no
 * credential is in the sandbox or readable in its firewall policy.
 */
export const INGEST_EGRESS_PATH = "/api/v1/sandbox-egress"

/** What one hosted ingest sandbox may reach, and the credentials for it. */
export type IngestEgressScope = {
  /** The Vercel sandbox name; a request from another sandbox is refused. */
  sandbox: string
  /** Epoch milliseconds after which the scope is refused (the shard limit). */
  exp: number
  backendHost: string
  git: IngestGitAccess[]
  /** Public plain git repositories: Git fetch with no credential (CTX-815). */
  plainGit?: PlainGitRepository[]
  /** The running step's credentials; without a step, Git fetch only. */
  step?: HostedTurnCredentials
}

const IV_LENGTH = 12
const TAG_LENGTH = 16
const SEAL_CONTEXT = "ctxpipe-ingest-egress-v2"

function sealKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", SEAL_CONTEXT, 32))
}

/**
 * Compress, encrypt, and authenticate a scope (AES-256-GCM) as one URL path
 * segment. The compression keeps the `forwardURL` of a step small: Vercel
 * answers 500 to a network policy whose forward URLs are too long (CTX-887).
 */
export function sealIngestEgressScope(
  scope: IngestEgressScope,
  secret: string,
): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv)
  cipher.setAAD(Buffer.from(SEAL_CONTEXT))
  const data = Buffer.concat([
    cipher.update(deflateRawSync(JSON.stringify(scope))),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")
}

/** The scope of a sealed value, or null when it is changed or not ours. */
export function openIngestEgressScope(
  sealed: string,
  secret: string,
): IngestEgressScope | null {
  try {
    const raw = Buffer.from(sealed, "base64url")
    if (raw.length <= IV_LENGTH + TAG_LENGTH) return null
    const decipher = createDecipheriv(
      "aes-256-gcm",
      sealKey(secret),
      raw.subarray(0, IV_LENGTH),
    )
    decipher.setAAD(Buffer.from(SEAL_CONTEXT))
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
    // Only after the tag check: only the backend made this compressed data.
    const text = inflateRawSync(
      Buffer.concat([
        decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)),
        decipher.final(),
      ]),
    ).toString("utf8")
    return JSON.parse(text) as IngestEgressScope
  } catch {
    return null
  }
}

/** The `forwardURL` of a scope's firewall rules. */
export function ingestEgressForwardUrl(
  scope: IngestEgressScope,
  secret: string,
): string {
  return `https://${scope.backendHost}${INGEST_EGRESS_PATH}/${sealIngestEgressScope(scope, secret)}`
}

/**
 * A rule with the methods and the query it allows. A rule with no
 * `authorization` adds no credential (a public plain git repository).
 */
type EgressRule = Omit<SandboxCredentialRule, "authorization"> & {
  authorization?: string
  methods: string[]
  /** The exact query (with `?`); without it, no query. */
  query?: string
}

/**
 * The size limit of one answer of a plain git host (CTX-815): the clone of
 * the history window of a source repository that is not on GitHub. A host
 * that we do not control cannot fill the sandbox disk or hold the proxy.
 */
const PLAIN_GIT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * A stream that passes at most `limit` bytes. After that, it ends with the
 * error of `tooLarge`, and the upstream stream is canceled.
 */
function byteLimit(
  limit: number,
  tooLarge: () => string,
): TransformStream<Uint8Array, Uint8Array> {
  let total = 0
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength
      if (total > limit) controller.error(new Error(tooLarge()))
      else controller.enqueue(chunk)
    },
  })
}

/** Git fetch only: `info/refs` for `git-upload-pack`, then `git-upload-pack`. */
function fetchOnly<T extends { path?: string }>(
  rule: T,
): T & { methods: string[]; query?: string } {
  return rule.path?.endsWith("/info/refs")
    ? { ...rule, methods: ["GET"], query: "?service=git-upload-pack" }
    : { ...rule, methods: ["POST"] }
}

/**
 * The only requests a scope allows: Git fetch (`info/refs` for
 * `git-upload-pack`, then `git-upload-pack`) of its repositories, and during
 * a step, the step's model proxy and tool bridge. Each by exact host, path,
 * method, and query.
 */
function egressRules(scope: IngestEgressScope): EgressRule[] {
  const { step, backendHost } = scope
  const git: EgressRule[] = [
    ...scope.git.flatMap((entry) =>
      githubFetchCredentialRules(entry.token, entry.repositories).map(
        fetchOnly,
      ),
    ),
    ...(scope.plainGit ?? []).flatMap((repository) =>
      plainGitFetchRules(repository).map(fetchOnly),
    ),
  ]
  if (!step) return git
  const [chat, models] = modelProxyCredentialRules(
    `https://${backendHost}${step.modelProxyPath}`,
    step.modelCapability,
  )
  return [
    ...git,
    // An MCP client can open a GET stream; the bridge answers it with 405.
    {
      ...bearerUrlRule(
        "tool-bridge",
        `https://${backendHost}${step.bridgePath}`,
        step.bridgeToken,
      ),
      methods: ["GET", "POST"],
    },
    ...(chat ? [{ ...chat, methods: ["POST"] }] : []),
    ...(models ? [{ ...models, methods: ["GET"] }] : []),
  ]
}

/** The request headers that the proxy sends on; also each `mcp-*` header. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-encoding",
  "git-protocol",
  "user-agent",
]

function forwardedHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of source)
    if (FORWARDED_REQUEST_HEADERS.includes(name) || name.startsWith("mcp-"))
      headers.set(name, value)
  return headers
}

/**
 * True when a path has a `.` or `..` segment, also percent-encoded. A URL
 * parser resolves them, so the path that a check sees and the path that
 * the upstream gets can differ.
 */
function hasDotSegment(path: string): boolean {
  const pathname = path.split("?")[0] ?? ""
  return pathname.split("/").some((segment) => {
    const dots = segment.replace(/%2e/gi, ".")
    return dots === "." || dots === ".."
  })
}

/** The OIDC header of a forwarded request (`@vercel/sandbox/proxy`). */
const OIDC_TOKEN_HEADER = "vercel-sandbox-oidc-token"

/** The issuer of a sandbox OIDC token: Vercel's, with a team id. */
const SANDBOX_OIDC_ISSUER = /^https:\/\/oidc\.vercel\.com\/team_[A-Za-z0-9]+$/

/** `fetch` decodes the body, so the encoding and length no longer apply. */
const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]

function refuse(reason: string, meta?: ProxyMeta): Response {
  log.warn({
    step: "ingest-egress-refused",
    message: `The ingest egress proxy refused a request: ${reason}`,
    ...(meta
      ? { sandboxId: meta.sandboxId, sandboxName: meta.sandboxName }
      : {}),
  })
  return new Response("Forbidden", { status: 403 })
}

/** The unverified `iss` of a token, or undefined when it does not decode. */
function unverifiedIssuer(token: string | null): string | undefined {
  if (!token) return undefined
  try {
    return decodeJwt(token).iss
  } catch {
    return undefined
  }
}

/**
 * Handle one request that the Vercel firewall forwarded. `request.url` must
 * be the public URL (the OIDC audience is the forward URL); `sealed` is the
 * scope segment of its path. `@vercel/sandbox/proxy` verifies the OIDC
 * token (issuer, audience, signature, expiry). This then requires our team
 * and project, the scope's sandbox, and an allowed request. It sets the
 * credential on the server side and does not follow redirects. Each other
 * request gets 403.
 *
 * Before the library verifies the token, the token's issuer must be ours
 * (`vercelOidcIssuer` of our team id): the library fetches and keeps the
 * keys of each issuer that it sees. An issuer that is not of the form
 * `https://oidc.vercel.com/team_…` is refused before the team lookup, so a
 * request with any other token causes no outbound request.
 */
export async function ingestEgressProxy(input: {
  request: Request
  sealed: string
  secret: string
  /** The team and project of our sandboxes. */
  vercel: () => Promise<{ teamId: string; projectId: string }>
  /** The DNS lookup of a plain git host; defaults to the system resolver. */
  lookup?: PlainGitLookup
  /** The size limit of one plain git answer; a test sets a small one. */
  plainGitMaxBytes?: number
}): Promise<Response> {
  const forwardedPath = input.request.headers.get("vercel-forwarded-path")
  if (forwardedPath !== null && hasDotSegment(forwardedPath))
    return refuse("a dot segment in the path")
  // Only the form of a sandbox token's issuer passes, before any lookup.
  const issuer = unverifiedIssuer(input.request.headers.get(OIDC_TOKEN_HEADER))
  if (!issuer || !SANDBOX_OIDC_ISSUER.test(issuer))
    return refuse("not a Vercel sandbox OIDC issuer")
  let vercel: { teamId: string; projectId: string }
  try {
    vercel = await input.vercel()
  } catch (error) {
    return refuse(`no Vercel credentials: ${String(error)}`)
  }
  if (issuer !== vercelOidcIssuer(vercel.teamId))
    return refuse("another OIDC issuer")
  const handle = defineSandboxProxy(
    async (request, meta) => {
      if (meta.teamId !== vercel.teamId || meta.projectId !== vercel.projectId)
        return refuse("another Vercel team or project", meta)
      const scope = openIngestEgressScope(input.sealed, input.secret)
      if (!scope) return refuse("the scope is not valid", meta)
      if (!(scope.exp > Date.now())) return refuse("the scope expired", meta)
      if (scope.sandbox !== meta.sandboxName)
        return refuse("the scope is for another sandbox", meta)
      const url = new URL(request.url)
      if (url.protocol !== "https:") return refuse("not HTTPS", meta)
      // GitHub owner and repository names have no case, and the scope keeps
      // them in lower case: a Git path matches in any case.
      const samePath = (path: string | undefined) =>
        url.host === "github.com"
          ? path?.toLowerCase() === url.pathname.toLowerCase()
          : path === url.pathname
      const rule = egressRules(scope).find(
        (candidate) =>
          candidate.host === url.host &&
          samePath(candidate.path) &&
          (candidate.query ?? "") === url.search &&
          candidate.methods.includes(request.method),
      )
      if (!rule)
        return refuse(`${request.method} ${url.host}${url.pathname}`, meta)
      const headers = forwardedHeaders(request.headers)
      if (rule.authorization) headers.set("authorization", rule.authorization)
      // A plain git host must resolve only to public addresses (CTX-815).
      // The proxy follows no redirect of a plain git host, and a redirect of
      // GitHub to another path or host has no rule. This proxy is hosted
      // only, so it always uses the strict hosted policy, whatever the
      // environment of the process is.
      const plainGit = !rule.authorization
      if (plainGit) {
        const refused = await resolvePlainGitRemote(
          `https://${url.host}${url.pathname}`,
          input.lookup,
          plainGitUrlPolicy("hosted"),
        ).then(
          () => null,
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        )
        if (refused !== null) return refuse(`${url.host}: ${refused}`, meta)
      }
      const body = request.method === "GET" ? null : request.body
      // A plain git host that does not start its answer in 60 seconds
      // gets no more time. The size limit below stops a long answer.
      const upstreamAbort = new AbortController()
      const timer = plainGit
        ? setTimeout(
            () =>
              upstreamAbort.abort(
                new Error("The plain git host did not answer in time"),
              ),
            60_000,
          )
        : undefined
      let upstream: Response
      try {
        upstream = await fetch(url, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
          redirect: plainGit ? "error" : "manual",
          signal: upstreamAbort.signal,
          duplex: "half",
        } as RequestInit)
      } catch (error) {
        log.warn({
          step: "ingest-egress-upstream",
          message: `The ingest egress proxy could not reach ${url.host}: ${String(error)}`,
          sandboxId: meta.sandboxId,
          sandboxName: meta.sandboxName,
        })
        return new Response("Bad Gateway", { status: 502 })
      } finally {
        clearTimeout(timer)
      }
      const responseHeaders = new Headers(upstream.headers)
      for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name)
      let answer: ReadableStream<Uint8Array> | null = upstream.body
      if (plainGit && answer) {
        const limit = input.plainGitMaxBytes ?? PLAIN_GIT_MAX_RESPONSE_BYTES
        const tooLarge = () => {
          const message = `The plain git host ${url.host} sent an answer larger than the limit of ${limit} bytes`
          log.warn({
            step: "ingest-egress-plain-git-size",
            message,
            sandboxId: meta.sandboxId,
            sandboxName: meta.sandboxName,
          })
          return message
        }
        if (Number(upstream.headers.get("content-length")) > limit) {
          upstreamAbort.abort()
          return new Response(tooLarge(), { status: 502 })
        }
        answer = answer.pipeThrough(byteLimit(limit, tooLarge))
      }
      return new Response(answer, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
    },
    (_request, error) => Promise.resolve(refuse(error.message)),
  )
  return handle(input.request)
}
