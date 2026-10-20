import { gzipSync } from "node:zlib"
import { OpenAPIHono } from "@hono/zod-openapi"
import { Sandbox } from "@vercel/sandbox"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import type { RootExec } from "../domain/ingestion/ingest-root.js"
import { withShardStep } from "../domain/ingestion/ingest-shard-step.js"
import {
  type IngestEgressScope,
  ingestEgressProxy,
  sealIngestEgressScope,
} from "../domain/workspaces/ingest-egress-proxy.js"
import {
  ingestNetworkPolicy,
  vercelIngestSandboxProvider,
} from "../domain/workspaces/ingest-sandbox-egress.js"
import {
  registerSandboxEgressRoute,
  sandboxEgressGuard,
} from "./sandbox-egress.js"

/** The DNS answers of the plain git hosts (the environment of the test). */
const dnsAnswers = new Map<string, string[]>([
  ["git.example.org", ["93.184.215.14"]],
  ["private.example.org", ["93.184.215.14", "169.254.169.254"]],
  ["lan.example.org", ["10.20.0.15"]],
])
const lookup = async (host: string) =>
  (dnsAnswers.get(host) ?? []).map((address) => ({ address }))

const secret = "egress-test-secret-0123456789abcdef"
const backendHost = "app.example.test"
const teamSlug = "egress-test"
const team = "team_egress"
// A real sandbox token's issuer names the team id, not its slug.
const issuer = `https://oidc.vercel.com/${team}`
const project = "prj_egress"
const step = {
  modelProxyPath: "/acme/api/v1/workspace-chat/openai/v1",
  modelCapability: "ingest-capability",
  bridgePath: "/api/v1/workspace-chat/tool-bridge/bridge-1",
  bridgeToken: "bridge-token",
}
const scope: IngestEgressScope = {
  sandbox: "sbx-ingest",
  exp: Date.now() + 60 * 60_000,
  backendHost,
  git: [{ token: "git-1", repositories: ["acme/source", "acme/context"] }],
  step,
}
const basic = `Basic ${Buffer.from("x-access-token:git-1").toString("base64")}`

type Seen = {
  method: string
  url: string
  authorization: string | null
  body: string
}
const seen: Seen[] = []
/** The headers of each upstream request. */
const upstreamHeaders: Headers[] = []
/** Each outbound URL, also the OIDC key fetches. */
const outbound: string[] = []
const record = async ({ request }: { request: Request }) => {
  upstreamHeaders.push(request.headers)
  seen.push({
    method: request.method,
    url: request.url,
    authorization: request.headers.get("authorization"),
    body: await request.text(),
  })
  return HttpResponse.text("upstream-ok", {
    headers: { "x-upstream": "yes" },
  })
}

const keys = await generateKeyPair("RS256")
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" }
const server = setupServer(
  http.get(`${issuer}/.well-known/jwks`, () =>
    HttpResponse.json({ keys: [jwk] }),
  ),
  // The deploy names the team by slug; the project lookup gives the ids.
  http.get(`https://api.vercel.com/v9/projects/${project}`, () =>
    HttpResponse.json({ id: project, accountId: team }),
  ),
  http.all("https://github.com/*", record),
  http.all("https://git.example.org/*", record),
  http.all("https://private.example.org/*", record),
  http.all("https://lan.example.org/*", record),
  http.all(`https://${backendHost}/*`, record),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
server.events.on("request:start", ({ request }) => {
  outbound.push(request.url)
})
afterAll(() => server.close())
beforeEach(() => {
  seen.length = 0
  upstreamHeaders.length = 0
  outbound.length = 0
  vi.stubEnv("VERCEL_TOKEN", "vercel-token")
  vi.stubEnv("VERCEL_TEAM_ID", teamSlug)
  vi.stubEnv("VERCEL_PROJECT_ID", project)
})
afterEach(() => {
  vi.unstubAllEnvs()
  server.resetHandlers()
})

function egressApp(plainGitMaxBytes?: number) {
  const env = parseEnv({
    DATABASE_URL: "postgres://unused@localhost:5432/unused",
    AUTH_SECRET: secret,
    AUTH_BASE_URL: `https://${backendHost}`,
  })
  const app = new OpenAPIHono<AppEnv>()
  app.use(
    "*",
    sandboxEgressGuard(() => true),
  )
  app.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  registerSandboxEgressRoute(app, {
    lookup,
    ...(plainGitMaxBytes ? { plainGitMaxBytes } : {}),
  })
  // Another backend route, as the sandbox must never reach it.
  app.all("/:orgSlug/api/v1/*", (c) => c.text("reached"))
  return app
}

function oidcToken(
  audience: string,
  claims: Record<string, string> = {},
  tokenIssuer = issuer,
) {
  return new SignJWT({
    team_id: team,
    project_id: project,
    sandbox_id: "sbx_id_1",
    sandbox_name: "sbx-ingest",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(tokenIssuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey)
}

/**
 * A request as the Vercel firewall forwards it: to the policy's forward URL
 * plus the original path, with the original target in `vercel-forwarded-*`
 * headers and an OIDC token for the forward URL. The backend sees its own
 * origin as plain HTTP behind the platform's TLS proxy.
 */
async function forwarded(
  target: string,
  options: {
    method?: string
    body?: string | Uint8Array<ArrayBuffer>
    headers?: Record<string, string>
    sealed?: string
    /** The forwarded path as sent, without URL normalization. */
    rawPath?: string
    audience?: string
    claims?: Record<string, string>
    issuer?: string
    /** The request path as the backend sees it; defaults to the forward URL plus `path`. */
    requestPath?: string
    /** The size limit of one plain git answer. */
    plainGitMaxBytes?: number
  } = {},
) {
  const sealed = options.sealed ?? sealIngestEgressScope(scope, secret)
  const forwardUrl = `https://${backendHost}/api/v1/sandbox-egress/${sealed}`
  const url = new URL(target)
  const path = options.rawPath ?? `${url.pathname}${url.search}`
  return egressApp(options.plainGitMaxBytes).request(
    `http://127.0.0.1:3000${options.requestPath ?? `/api/v1/sandbox-egress/${sealed}${path}`}`,
    {
      method: options.method ?? "GET",
      ...(options.body ? { body: options.body } : {}),
      headers: {
        ...options.headers,
        "vercel-forwarded-host": url.hostname,
        "vercel-forwarded-scheme": url.protocol.replace(":", ""),
        "vercel-forwarded-port":
          url.port || (url.protocol === "https:" ? "443" : "80"),
        "vercel-forwarded-path": path,
        "vercel-sandbox-oidc-token": await oidcToken(
          options.audience ?? forwardUrl,
          options.claims,
          options.issuer,
        ),
      },
    },
  )
}

describe("the ingest egress proxy route", () => {
  it("adds the GitHub read token to a Git fetch of the shard's repositories and passes the reply back", async () => {
    const refs = await forwarded(
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
    )
    expect(refs.status).toBe(200)
    expect(await refs.text()).toBe("upstream-ok")
    expect(refs.headers.get("x-upstream")).toBe("yes")
    const pack = await forwarded(
      "https://github.com/acme/context.git/git-upload-pack",
      { method: "POST", body: "0032want abc\n0000" },
    )
    expect(pack.status).toBe(200)
    expect(seen).toEqual([
      {
        method: "GET",
        url: "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
        authorization: basic,
        body: "",
      },
      {
        method: "POST",
        url: "https://github.com/acme/context.git/git-upload-pack",
        authorization: basic,
        body: "0032want abc\n0000",
      },
    ])
  })

  it("sends a gzip Git fetch body on with its encoding, as Git sends a large want list (CTX-887)", async () => {
    // Git gzips a fetch body above 1 KB, for example the lazy fetch of
    // many blobs in a blobless clone. Without the header, GitHub reads
    // the gzip bytes as pkt-lines and answers 400.
    const wants = "0032want abc\n".repeat(100) + "0000"
    const pack = await forwarded(
      "https://github.com/acme/context.git/git-upload-pack",
      {
        method: "POST",
        body: new Uint8Array(gzipSync(wants)),
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "gzip",
        },
      },
    )
    expect(pack.status).toBe(200)
    expect(upstreamHeaders[0]?.get("content-encoding")).toBe("gzip")
  })

  it("matches a Git path in any case, as GitHub names have no case; other paths stay exact", async () => {
    // A Workspace URL can name `Acme/Source`; the scope keeps `acme/source`.
    const refs = await forwarded(
      "https://github.com/Acme/Source.git/info/refs?service=git-upload-pack",
    )
    expect(refs.status).toBe(200)
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://github.com/Acme/Source.git/info/refs?service=git-upload-pack",
    ])
    const models = await forwarded(
      `https://${backendHost}${step.modelProxyPath.toUpperCase()}/models`,
    )
    expect(models.status).toBe(403)
  })

  it("replaces a credential that the sandbox sends with the shard's token", async () => {
    const response = await forwarded(
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
      {
        headers: {
          authorization: `Basic ${Buffer.from("x:ghp_sandbox").toString("base64")}`,
          cookie: "user_session=stolen",
        },
      },
    )
    expect(response.status).toBe(200)
    expect(seen.map((request) => request.authorization)).toEqual([basic])
  })

  it("refuses a push, also with a token in the URL, and does not send it", async () => {
    const withToken = {
      authorization: `Basic ${Buffer.from("x-access-token:ghs_own").toString("base64")}`,
    }
    for (const [target, method] of [
      ["https://github.com/acme/source.git/git-receive-pack", "POST"],
      [
        "https://github.com/acme/source.git/info/refs?service=git-receive-pack",
        "GET",
      ],
    ] as const) {
      const response = await forwarded(target, {
        method,
        headers: withToken,
        ...(method === "POST" ? { body: "0000" } : {}),
      })
      expect(response.status, target).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it("refuses another repository, another GitHub path, and another method", async () => {
    for (const [target, method] of [
      [
        "https://github.com/acme/other.git/info/refs?service=git-upload-pack",
        "GET",
      ],
      ["https://github.com/acme/source", "GET"],
      ["https://github.com/acme/source.git/git-upload-pack", "GET"],
      ["https://github.com/acme/source.git/info/refs", "GET"],
      [
        "https://github.com/acme/source.git/info/refs?service=git-upload-pack&x=1",
        "GET",
      ],
      [
        "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
        "POST",
      ],
    ] as const) {
      const response = await forwarded(target, {
        method,
        ...(method === "POST" ? { body: "0000" } : {}),
      })
      expect(response.status, `${method} ${target}`).toBe(403)
    }
    for (const rawPath of [
      "/acme/source.git/../other.git/git-upload-pack",
      "/acme/source.git/%2e%2e/other.git/git-upload-pack",
    ]) {
      const response = await forwarded("https://github.com/acme/other.git", {
        method: "POST",
        body: "0000",
        rawPath,
      })
      expect(response.status, rawPath).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it("adds the step's credentials on its model proxy and tool bridge paths only", async () => {
    const chat = await forwarded(
      `https://${backendHost}${step.modelProxyPath}/chat/completions`,
      { method: "POST", body: "{}" },
    )
    const models = await forwarded(
      `https://${backendHost}${step.modelProxyPath}/models`,
    )
    const bridge = await forwarded(`https://${backendHost}${step.bridgePath}`, {
      method: "POST",
      body: "{}",
    })
    expect([chat.status, models.status, bridge.status]).toEqual([200, 200, 200])
    expect(seen.map((request) => [request.url, request.authorization])).toEqual(
      [
        [
          `https://${backendHost}${step.modelProxyPath}/chat/completions`,
          "Bearer ingest-capability",
        ],
        [
          `https://${backendHost}${step.modelProxyPath}/models`,
          "Bearer ingest-capability",
        ],
        [`https://${backendHost}${step.bridgePath}`, "Bearer bridge-token"],
      ],
    )
  })

  it("refuses an unlisted backend path, and the step's paths when no step runs", async () => {
    for (const target of [
      `https://${backendHost}/acme/api/v1/workspaces`,
      `https://${backendHost}${step.modelProxyPath}/../../../../api/v1/x`,
      `https://${backendHost}/api/v1/workspace-chat/tool-bridge/bridge-2`,
      `https://${backendHost}${step.modelProxyPath}/chat/completions?x=1`,
    ]) {
      const response = await forwarded(target, { method: "POST", body: "{}" })
      expect(response.status, target).toBe(403)
    }
    const idle = sealIngestEgressScope({ ...scope, step: undefined }, secret)
    const response = await forwarded(
      `https://${backendHost}${step.modelProxyPath}/chat/completions`,
      { method: "POST", body: "{}", sealed: idle },
    )
    expect(response.status).toBe(403)
    expect(seen).toEqual([])
  })

  it("refuses a request from another sandbox, team, or project", async () => {
    const cases: Record<string, string>[] = [
      { sandbox_name: "sbx-other" },
      { team_id: "team_other" },
      { project_id: "prj_other" },
    ]
    for (const claims of cases) {
      const response = await forwarded(
        "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
        { claims },
      )
      expect(response.status, JSON.stringify(claims)).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it("refuses a token for another forward URL, a changed scope, and plain HTTP", async () => {
    const other = sealIngestEgressScope({ ...scope, sandbox: "sbx-2" }, secret)
    const target =
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack"
    expect(
      (
        await forwarded(target, {
          audience: `https://${backendHost}/api/v1/sandbox-egress/${other}`,
        })
      ).status,
    ).toBe(403)
    const sealed = sealIngestEgressScope(scope, secret)
    const changed = `${sealed.slice(0, -4)}${sealed.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`
    expect((await forwarded(target, { sealed: changed })).status).toBe(403)
    const foreign = sealIngestEgressScope(
      scope,
      "another-secret-0123456789abcdefghij",
    )
    expect((await forwarded(target, { sealed: foreign })).status).toBe(403)
    expect(
      (
        await forwarded(
          "http://github.com/acme/source.git/info/refs?service=git-upload-pack",
        )
      ).status,
    ).toBe(403)
    expect(seen).toEqual([])
  })

  it("refuses a request without a valid OIDC token", async () => {
    const sealed = sealIngestEgressScope(scope, secret)
    const response = await egressApp().request(
      `http://127.0.0.1:3000/api/v1/sandbox-egress/${sealed}/acme/source.git/info/refs`,
      {
        headers: {
          "vercel-forwarded-host": "github.com",
          "vercel-forwarded-scheme": "https",
          "vercel-forwarded-port": "443",
          "vercel-forwarded-path": "/acme/source.git/info/refs",
        },
      },
    )
    expect(response.status).toBe(403)
    expect(seen).toEqual([])
  })

  it("does not follow a redirect from upstream", async () => {
    server.use(
      http.get("https://github.com/acme/source.git/info/refs", () =>
        HttpResponse.text("", {
          status: 302,
          headers: { location: "https://attacker.example.test/x" },
        }),
      ),
    )
    const response = await forwarded(
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "https://attacker.example.test/x",
    )
  })

  it("refuses a sandbox request that leaves the egress path, also by dot segments, before any route", async () => {
    const sealed = sealIngestEgressScope(scope, secret)
    const target =
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack"
    for (const requestPath of [
      `/api/v1/sandbox-egress/${sealed}/%2e%2e/%2e%2e/%2e%2e/acme/api/v1/workspaces`,
      `/api/v1/sandbox-egress/${sealed}/../../../acme/api/v1/workspaces`,
      "/acme/api/v1/workspaces",
    ]) {
      const response = await forwarded(target, {
        requestPath,
        headers: { "x-api-key": "sandbox-key", authorization: "Bearer own" },
      })
      expect(response.status, requestPath).toBe(403)
      expect(await response.text()).not.toBe("reached")
    }
    for (const name of [
      "vercel-sandbox-oidc-token",
      "vercel-forwarded-host",
      "vercel-forwarded-path",
    ]) {
      const response = await egressApp().request(
        "http://127.0.0.1:3000/acme/api/v1/workspaces",
        { headers: { [name]: "x" } },
      )
      expect(response.status, name).toBe(403)
    }
    expect(outbound).toEqual([])
  })

  it("refuses a forwarded request with a 403 when the egress route is not mounted", async () => {
    const app = new OpenAPIHono<AppEnv>()
    app.use(
      "*",
      sandboxEgressGuard(() => false),
    )
    app.all("*", (c) => c.text("ui catch-all"))
    for (const name of ["vercel-sandbox-oidc-token", "vercel-forwarded-host"]) {
      for (const path of ["/", `/api/v1/sandbox-egress/x/y`]) {
        const response = await app.request(`http://127.0.0.1:3000${path}`, {
          headers: { [name]: "x" },
        })
        expect(response.status, `${name} ${path}`).toBe(403)
      }
    }
    // A request without sandbox headers still reaches the app.
    const plain = await app.request("http://127.0.0.1:3000/")
    expect(await plain.text()).toBe("ui catch-all")
  })

  it("refuses a forwarded path with a dot segment, raw or encoded", async () => {
    for (const rawPath of [
      "/acme/x/../source.git/info/refs?service=git-upload-pack",
      "/acme/x/%2e%2e/source.git/info/refs?service=git-upload-pack",
      "/acme/x/%2E./source.git/info/refs?service=git-upload-pack",
      "/acme/./source.git/info/refs?service=git-upload-pack",
      "/acme/%2e/source.git/info/refs?service=git-upload-pack",
    ]) {
      const response = await forwarded("https://github.com/acme/source.git", {
        rawPath,
      })
      expect(response.status, rawPath).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it("refuses a token whose issuer is not a sandbox issuer before any lookup or key fetch", async () => {
    const target =
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack"
    const malformed = [
      // The slug is not the issuer of a sandbox token.
      `https://oidc.vercel.com/${teamSlug}`,
      `https://oidc.vercel.com/${team}/x`,
      `http://oidc.vercel.com/${team}`,
      "https://attacker.example.test",
      "https://attacker.example.test/team_egress",
    ]
    for (const other of malformed) {
      const response = await forwarded(target, { issuer: other })
      expect(response.status, other).toBe(403)
    }
    expect(outbound).toEqual([])
    expect(seen).toEqual([])
    // The proxy itself: no team lookup for such a token.
    let lookups = 0
    for (const other of malformed) {
      const response = await ingestEgressProxy({
        request: new Request(`https://${backendHost}/api/v1/sandbox-egress/x`, {
          headers: {
            "vercel-sandbox-oidc-token": await oidcToken("aud", {}, other),
          },
        }),
        sealed: "x",
        secret,
        vercel: async () => {
          lookups += 1
          return { teamId: team, projectId: project }
        },
      })
      expect(response.status, other).toBe(403)
    }
    expect(lookups).toBe(0)
  })

  it("refuses a token of another team without fetching its keys", async () => {
    const response = await forwarded(
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
      { issuer: "https://oidc.vercel.com/team_another" },
    )
    expect(response.status).toBe(403)
    expect(outbound.filter((url) => url.includes("jwks"))).toEqual([])
    expect(seen).toEqual([])
  })

  it("accepts the team configured by id, with no project lookup", async () => {
    vi.stubEnv("VERCEL_TEAM_ID", team)
    const response = await forwarded(
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack",
    )
    expect(response.status).toBe(200)
    expect(
      outbound.filter((url) => url.startsWith("https://api.vercel.com")),
    ).toEqual([])
  })

  it("refuses an expired scope", async () => {
    const target =
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack"
    const expired = sealIngestEgressScope(
      { ...scope, exp: Date.now() - 1 },
      secret,
    )
    expect((await forwarded(target, { sealed: expired })).status).toBe(403)
    // NaN seals as `null`: a scope without a time limit.
    const noExp = sealIngestEgressScope({ ...scope, exp: Number.NaN }, secret)
    expect((await forwarded(target, { sealed: noExp })).status).toBe(403)
    expect(seen).toEqual([])
  })

  it("sends on only the allowed request headers", async () => {
    const response = await forwarded(
      `https://${backendHost}${step.bridgePath}`,
      {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "session-1",
          "mcp-protocol-version": "2025-06-18",
          "user-agent": "opencode",
          "git-protocol": "version=2",
          "x-api-key": "sandbox-key",
          "x-real-ip": "10.0.0.1",
          "x-forwarded-for": "10.0.0.1",
          "cf-connecting-ip": "10.0.0.1",
          "x-ctxpipe-org": "other",
        },
      },
    )
    expect(response.status).toBe(200)
    const headers = Object.fromEntries(upstreamHeaders[0] ?? [])
    expect(headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "session-1",
      "mcp-protocol-version": "2025-06-18",
      "user-agent": "opencode",
      "git-protocol": "version=2",
      authorization: "Bearer bridge-token",
    })
    for (const name of [
      "x-api-key",
      "x-real-ip",
      "x-forwarded-for",
      "cf-connecting-ip",
      "x-ctxpipe-org",
    ])
      expect(headers[name], name).toBeUndefined()
  })

  it("answers a credential error with 403 and an upstream error with 502, with a fixed message", async () => {
    const target =
      "https://github.com/acme/source.git/info/refs?service=git-upload-pack"
    server.use(
      http.get("https://github.com/acme/source.git/info/refs", () =>
        HttpResponse.error(),
      ),
    )
    const failed = await forwarded(target)
    expect(failed.status).toBe(502)
    expect(await failed.text()).toBe("Bad Gateway")
    vi.stubEnv("VERCEL_TOKEN", "")
    const denied = await forwarded(target)
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe("Forbidden")
  })
})

describe("the ingest egress proxy route for a plain git source (CTX-815)", () => {
  const plainScope: IngestEgressScope = {
    ...scope,
    plainGit: [
      { host: "git.example.org", path: "/team/app.git" },
      { host: "private.example.org", path: "/team/app.git" },
      { host: "lan.example.org", path: "/team/app.git" },
    ],
  }
  const sealed = () => sealIngestEgressScope(plainScope, secret)

  it("forwards a Git fetch of the repository with no credential, also when the sandbox sends one", async () => {
    const refs = await forwarded(
      "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
      {
        sealed: sealed(),
        headers: { authorization: "Basic c2FuZGJveDpzZWNyZXQ=" },
      },
    )
    const pack = await forwarded(
      "https://git.example.org/team/app.git/git-upload-pack",
      { sealed: sealed(), method: "POST", body: "0032want abc\n0000" },
    )
    expect([refs.status, pack.status]).toEqual([200, 200])
    expect(seen).toEqual([
      {
        method: "GET",
        url: "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
        authorization: null,
        body: "",
      },
      {
        method: "POST",
        url: "https://git.example.org/team/app.git/git-upload-pack",
        authorization: null,
        body: "0032want abc\n0000",
      },
    ])
  })

  it("refuses another host, another path, a push, and another method", async () => {
    for (const [target, method] of [
      [
        "https://other.example.org/team/app.git/info/refs?service=git-upload-pack",
        "GET",
      ],
      [
        "https://git.example.org/team/other.git/info/refs?service=git-upload-pack",
        "GET",
      ],
      [
        "https://git.example.org/team/app.git.evil/info/refs?service=git-upload-pack",
        "GET",
      ],
      ["https://git.example.org/team/app.git", "GET"],
      ["https://git.example.org/team/app.git/git-receive-pack", "POST"],
      [
        "https://git.example.org/team/app.git/info/refs?service=git-receive-pack",
        "GET",
      ],
      ["https://git.example.org/team/app.git/git-upload-pack", "GET"],
      [
        "https://github.com/team/app.git/info/refs?service=git-upload-pack",
        "GET",
      ],
    ] as const) {
      const response = await forwarded(target, {
        sealed: sealed(),
        method,
        ...(method === "POST" ? { body: "0000" } : {}),
      })
      expect(response.status, `${method} ${target}`).toBe(403)
    }
    expect(seen).toEqual([])
  })

  it("refuses a Git fetch of the plain git source from a step after prepare: no POST body can leave to the git host", async () => {
    const plainGit = [{ host: "git.example.org", path: "/team/app.git" }]
    const sealedOf = (fetchSource: boolean) => {
      const policy = ingestNetworkPolicy({
        git: scope.git,
        plainGit,
        backendHost,
        secret,
        sandboxName: "sbx-ingest",
        step: fetchSource ? { ...step, fetchSource } : step,
      }) as { allow: Record<string, Array<{ forwardURL?: string }>> }
      return new URL(
        policy.allow["github.com"]?.[0]?.forwardURL ?? "",
      ).pathname.replace("/api/v1/sandbox-egress/", "")
    }
    const fetchOf = (sealed: string) =>
      Promise.all([
        forwarded(
          "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
          { sealed },
        ),
        forwarded("https://git.example.org/team/app.git/git-upload-pack", {
          sealed,
          method: "POST",
          body: "0032want abc\nWorkspace content\n0000",
        }),
      ]).then((responses) => responses.map((response) => response.status))
    expect(await fetchOf(sealedOf(false))).toEqual([403, 403])
    expect(seen).toEqual([])
    // During prepare, the same fetch reaches the host.
    expect(await fetchOf(sealedOf(true))).toEqual([200, 200])
  })

  it("stops a plain git answer that is larger than the size limit, with a clear error", async () => {
    const chunk = new Uint8Array(512).fill(65)
    server.use(
      // No length: the proxy counts the bytes as they pass.
      http.post(
        "https://git.example.org/team/app.git/git-upload-pack",
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 4; i++) controller.enqueue(chunk)
                controller.close()
              },
            }),
          ),
      ),
      // A declared length over the limit: refused before any byte passes.
      http.get(
        "https://git.example.org/team/app.git/info/refs",
        () =>
          new HttpResponse(new Uint8Array(4096), {
            headers: { "content-length": "4096" },
          }),
      ),
    )
    const message =
      "The plain git host git.example.org sent an answer larger than the limit of 1024 bytes"
    const pack = await forwarded(
      "https://git.example.org/team/app.git/git-upload-pack",
      {
        sealed: sealed(),
        method: "POST",
        body: "0032want abc\n0000",
        plainGitMaxBytes: 1024,
      },
    )
    expect(pack.status).toBe(200)
    await expect(pack.text()).rejects.toThrow(message)
    const refs = await forwarded(
      "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
      { sealed: sealed(), plainGitMaxBytes: 1024 },
    )
    expect(refs.status).toBe(502)
    expect(await refs.text()).toBe(message)
    // Under the limit, the whole answer passes.
    const small = await forwarded(
      "https://git.example.org/team/app.git/git-upload-pack",
      {
        sealed: sealed(),
        method: "POST",
        body: "0032want abc\n0000",
        plainGitMaxBytes: 4096,
      },
    )
    expect((await small.text()).length).toBe(2048)
  })

  it("refuses a plain git host that resolves to a private address", async () => {
    const response = await forwarded(
      "https://private.example.org/team/app.git/info/refs?service=git-upload-pack",
      { sealed: sealed() },
    )
    expect(response.status).toBe(403)
    expect(seen).toEqual([])
  })

  it("refuses a plain git host with a private address also when the process is self-host", async () => {
    // The proxy is hosted only: the Docker provider of the process must not
    // loosen it (it passes the hosted policy, not the process policy).
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
    const response = await forwarded(
      "https://lan.example.org/team/app.git/info/refs?service=git-upload-pack",
      { sealed: sealed() },
    )
    expect(response.status).toBe(403)
    expect(outbound.filter((url) => url.includes("lan.example.org"))).toEqual(
      [],
    )
  })

  it("does not follow a redirect of the plain git host, and answers 502", async () => {
    server.use(
      http.get("https://git.example.org/team/app.git/info/refs", () =>
        HttpResponse.text("", {
          status: 301,
          headers: {
            location:
              "https://private.example.org/team/app.git/info/refs?service=git-upload-pack",
          },
        }),
      ),
    )
    const response = await forwarded(
      "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
      { sealed: sealed() },
    )
    expect(response.status).toBe(502)
    expect(
      outbound.filter((url) => url.includes("private.example.org")),
    ).toEqual([])
  })

  it("answers 502 when the plain git host does not start its answer in 60 seconds", async () => {
    let reached = () => {}
    const asked = new Promise<void>((resolve) => {
      reached = resolve
    })
    server.use(
      http.get("https://git.example.org/team/app.git/info/refs", () => {
        reached()
        return new Promise<never>(() => {})
      }),
    )
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const response = forwarded(
        "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
        { sealed: sealed() },
      )
      await asked
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await response).status).toBe(502)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the plain git source fetch of a shard step (CTX-815)", () => {
  const name = "sbx-ingest"
  const vercel = { token: "t", teamId: team, projectId: project }
  const session = {
    id: "sess_shard_step",
    memory: 2048,
    vcpus: 1,
    region: "iad1",
    runtime: "node22",
    timeout: 60_000,
    status: "running",
    requestedAt: 1,
    createdAt: 1,
    cwd: "/vercel/sandbox",
    updatedAt: 1,
  }
  const sandbox = {
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: session.id,
    status: "running",
  }
  type Policy = { allow: Record<string, Array<{ forwardURL?: string }>> }
  /** Each network policy that Vercel applied, in order. */
  let applied: Policy[] = []
  /** The sandbox's prepared marker, as `ingestShardPrepared` reads it. */
  let prepared = false
  const root: RootExec = async (script) => ({
    exitCode: script.startsWith("test -f ") && !prepared ? 1 : 0,
    stdout: "",
    stderr: "",
  })
  const sealedOf = (policy: Policy | undefined) =>
    new URL(
      policy?.allow["github.com"]?.[0]?.forwardURL ?? "",
    ).pathname.replace("/api/v1/sandbox-egress/", "")
  /** A Git fetch of the source through the policy that Vercel applied last. */
  const fetchNow = () => {
    const sealed = sealedOf(applied.at(-1))
    return Promise.all([
      forwarded(
        "https://git.example.org/team/app.git/info/refs?service=git-upload-pack",
        { sealed },
      ),
      forwarded("https://git.example.org/team/app.git/git-upload-pack", {
        sealed,
        method: "POST",
        body: "0032want abc\nWorkspace content\n0000",
      }),
    ]).then((responses) => responses.map((response) => response.status))
  }

  async function hostedFirewall() {
    vi.stubEnv("AUTH_SECRET", secret)
    vi.stubEnv("DATABASE_URL", "postgres://unused@localhost:5432/unused")
    vi.stubEnv("AUTH_BASE_URL", `https://${backendHost}`)
    server.use(
      http.get(`https://vercel.com/api/v2/sandboxes/${name}`, () =>
        HttpResponse.json({ sandbox, session, routes: [] }),
      ),
      http.patch(
        `https://vercel.com/api/v2/sandboxes/${name}`,
        async ({ request }) => {
          const body = (await request.json()) as { networkPolicy: Policy }
          applied.push(body.networkPolicy)
          return HttpResponse.json({ sandbox })
        },
      ),
      http.post(
        `https://vercel.com/api/v2/sandboxes/sessions/${session.id}/network-policy`,
        () => HttpResponse.json({ session }),
      ),
    )
    const { firewall } = vercelIngestSandboxProvider({
      orgId: "org_shard_step",
      runId: "run_shard_step",
      shard: 0,
      repositories: [
        { kind: "git", host: "git.example.org", path: "/team/app.git" },
      ],
      backendHost,
      credentials: vercel,
      agentPassword: "password",
      tags: {},
      agentSnapshot: async () => "snap_test",
    })
    // The provider attaches the sandbox at each step's create or resume.
    const attach = async () =>
      firewall.attach(
        await Sandbox.get({ ...vercel, name, resume: false }),
        "git-1",
      )
    return { firewall, attach }
  }

  /** One step as `withShard` runs it; `prepare` and `stopAgents` fetch too. */
  function stepOf(
    hosted: Awaited<ReturnType<typeof hostedFirewall>> | undefined,
    input: {
      existing: boolean
      refresh?: (fetchSource: boolean) => Promise<void>
      prepare?: () => Promise<void>
      stopAgents?: () => Promise<void>
    },
  ) {
    return withShardStep({
      existingRoot: input.existing ? root : null,
      plainGitSource: true,
      firewall: hosted?.firewall,
      credentials: step,
      refresh:
        input.refresh ??
        (() => Promise.reject(new Error("A hosted step refreshes no vault"))),
      attach: async () => {
        await hosted?.attach()
        return { handle: { id: name }, root }
      },
      prepare: async () => {
        await input.prepare?.()
        prepared = true
      },
      run: fetchNow,
      stopAgents: async () => {
        await input.stopAgents?.()
      },
      logContext: { orgId: "org_shard_step", runId: "run_shard_step" },
    })
  }

  it("reaches the plain git host only while it prepares a new or an unprepared sandbox; the step after it gets 403", async () => {
    const hosted = await hostedFirewall()
    const duringPrepare: number[][] = []
    const fetchInPrepare = async () => {
      duringPrepare.push(await fetchNow())
    }

    // A new sandbox: prepare, then the step.
    prepared = false
    expect(
      await stepOf(hosted, { existing: false, prepare: fetchInPrepare }),
    ).toEqual([403, 403])
    expect(duringPrepare).toEqual([[200, 200]])

    // An existing, prepared sandbox does not prepare, and never gets the
    // plain git host.
    applied = []
    expect(
      await stepOf(hosted, { existing: true, prepare: fetchInPrepare }),
    ).toEqual([403, 403])
    expect(duringPrepare).toHaveLength(1)
    expect(applied.some((policy) => "git.example.org" in policy.allow)).toBe(
      false,
    )

    // An existing sandbox whose prepare did not finish prepares again.
    prepared = false
    expect(
      await stepOf(hosted, { existing: true, prepare: fetchInPrepare }),
    ).toEqual([403, 403])
    expect(duringPrepare).toEqual([
      [200, 200],
      [200, 200],
    ])
  })

  it("removes the plain git host when the prepare fails, before the step's agents are stopped", async () => {
    const hosted = await hostedFirewall()
    prepared = false
    let duringPrepare: number[] = []
    let afterFailure: number[] = []
    await expect(
      stepOf(hosted, {
        existing: false,
        prepare: async () => {
          duringPrepare = await fetchNow()
          throw new Error("The clone failed")
        },
        stopAgents: async () => {
          afterFailure = await fetchNow()
        },
      }),
    ).rejects.toThrow("The clone failed")
    expect(duringPrepare).toEqual([200, 200])
    expect(afterFailure).toEqual([403, 403])
    expect(prepared).toBe(false)
  })

  it("Docker: sets the vault rules with the source fetch only for the prepare, also when it fails", async () => {
    const refreshes: boolean[] = []
    const refresh = async (fetchSource: boolean) => {
      refreshes.push(fetchSource)
    }
    // An existing, prepared sandbox: this step's rules, with no source fetch.
    prepared = true
    await stepOf(undefined, { existing: true, refresh })
    expect(refreshes).toEqual([false])
    // An existing, unprepared sandbox: the source fetch, then no fetch.
    prepared = false
    await stepOf(undefined, { existing: true, refresh })
    expect(refreshes).toEqual([false, true, false])
    // A new sandbox got the source fetch rules at create; a failed prepare
    // removes them.
    prepared = false
    await expect(
      stepOf(undefined, {
        existing: false,
        refresh,
        prepare: () => Promise.reject(new Error("The clone failed")),
      }),
    ).rejects.toThrow("The clone failed")
    expect(refreshes).toEqual([false, true, false, false])
  })
})
