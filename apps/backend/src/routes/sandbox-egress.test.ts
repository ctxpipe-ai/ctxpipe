import { OpenAPIHono } from "@hono/zod-openapi"
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
import {
  type IngestEgressScope,
  ingestEgressProxy,
  sealIngestEgressScope,
} from "../domain/workspaces/ingest-egress-proxy.js"
import {
  registerSandboxEgressRoute,
  sandboxEgressGuard,
} from "./sandbox-egress.js"

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

function egressApp() {
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
  registerSandboxEgressRoute(app)
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
    body?: string
    headers?: Record<string, string>
    sealed?: string
    /** The forwarded path as sent, without URL normalization. */
    rawPath?: string
    audience?: string
    claims?: Record<string, string>
    issuer?: string
    /** The request path as the backend sees it; defaults to the forward URL plus `path`. */
    requestPath?: string
  } = {},
) {
  const sealed = options.sealed ?? sealIngestEgressScope(scope, secret)
  const forwardUrl = `https://${backendHost}/api/v1/sandbox-egress/${sealed}`
  const url = new URL(target)
  const path = options.rawPath ?? `${url.pathname}${url.search}`
  return egressApp().request(
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
