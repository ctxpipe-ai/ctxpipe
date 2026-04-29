#!/usr/bin/env bun
/**
 * OAuth 2.1 refresh probe against ctx| Better Auth (same paths as MCP OAuth).
 *
 * Usage:
 *   AUTH_BASE_URL=https://app.ctxpipe.ai bun scripts/oauth-refresh-probe.ts
 *   AUTH_BASE_URL=... CTXPIPE_ORG_SLUG=acme bun scripts/oauth-refresh-probe.ts --mcp
 *
 * Replay refresh only (no browser):
 *   bun scripts/oauth-refresh-probe.ts --replay-refresh \
 *     --client-id=... --refresh-token=...
 *
 * @see scripts/README.md#oauth-refresh-probe
 */

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { parseArgs } from "node:util"

const OAUTH_SCOPE = "openid profile email offline_access"
const CALLBACK_PATH = "/oauth/callback"
const DEFAULT_CALLBACK_PORT = 8765

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

function usage(): never {
  console.error(`Usage:
  Full flow (browser login):
    AUTH_BASE_URL=https://app.ctxpipe.ai bun scripts/oauth-refresh-probe.ts [--mcp] [--port=8765] [--no-open]

  Replay refresh only:
    AUTH_BASE_URL=https://app.ctxpipe.ai bun scripts/oauth-refresh-probe.ts --replay-refresh \\
      --client-id=CLIENT_ID --refresh-token=REFRESH_TOKEN

  Optional: CTXPIPE_ORG_SLUG=your-org for --mcp (POST /mcp?orgSlug=... with Bearer).
`)
  process.exit(1)
}

function baseUrl(): string {
  const u = process.env.AUTH_BASE_URL?.replace(/\/$/, "")
  if (!u) {
    console.error("Missing AUTH_BASE_URL (e.g. https://app.ctxpipe.ai)")
    usage()
  }
  return u
}

function authPrefix(base: string): string {
  return `${base}/.auth/api/v1/auth`
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function generateCodeVerifier(): string {
  return b64url(randomBytes(32))
}

async function sha256B64Url(input: string): Promise<string> {
  const hash = createHash("sha256").update(input).digest()
  return b64url(hash)
}

function formEncode(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as T
  return { status: res.status, json }
}

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; text: string; json: TokenResponse }> {
  const body = formEncode(params)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })
  const text = await res.text()
  let json: TokenResponse = {}
  try {
    json = JSON.parse(text) as TokenResponse
  } catch {
    json = { error: "parse_error", error_description: text.slice(0, 500) }
  }
  return { status: res.status, text, json }
}

function redactTokens(obj: TokenResponse): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj }
  if (typeof out.access_token === "string")
    out.access_token = `[redacted len=${(out.access_token as string).length}]`
  if (typeof out.refresh_token === "string")
    out.refresh_token = `[redacted len=${(out.refresh_token as string).length}]`
  return out
}

function printTokenResult(
  label: string,
  status: number,
  json: TokenResponse,
): void {
  console.log(`\n--- ${label} ---`)
  console.log(`HTTP ${status}`)
  console.log(JSON.stringify(redactTokens(json), null, 2))
  if (json.error) {
    console.log("Full error (no token redaction in error fields):")
    console.log(
      JSON.stringify(
        { error: json.error, error_description: json.error_description },
        null,
        2,
      ),
    )
  }
}

async function registerClient(
  authBase: string,
  redirectUri: string,
): Promise<{ client_id: string }> {
  const url = `${authPrefix(authBase)}/oauth2/register`
  const { status, json } = await postJson<{
    client_id?: string
    error?: string
    error_description?: string
  }>(url, {
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    type: "native",
    scope: OAUTH_SCOPE,
    client_name: "oauth-refresh-probe-cli",
  })
  if (status !== 200 || !json.client_id) {
    console.error("Registration failed:", status, json)
    process.exit(1)
  }
  console.log("Registered OAuth client:", json.client_id)
  return { client_id: json.client_id }
}

function openBrowser(url: string): void {
  const platform = process.platform
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"
  const child =
    platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
        })
      : spawn(cmd, [url], { detached: true, stdio: "ignore" })
  child.unref()
}

async function waitForCallback(
  port: number,
  expectedState: string,
  timeoutMs: number,
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
      if (u.pathname !== CALLBACK_PATH) {
        res.writeHead(404)
        res.end("Not found")
        return
      }
      const code = u.searchParams.get("code")
      const state = u.searchParams.get("state")
      const err = u.searchParams.get("error")
      const desc = u.searchParams.get("error_description")
      if (err) {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end(`OAuth error: ${err}\n${desc ?? ""}`)
        server.close()
        reject(new Error(`Authorize redirect error: ${err} ${desc ?? ""}`))
        return
      }
      if (!code || !state) {
        res.writeHead(400)
        res.end("Missing code or state")
        return
      }
      if (state !== expectedState) {
        res.writeHead(400)
        res.end("State mismatch")
        server.close()
        reject(new Error("State mismatch"))
        return
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(
        "<html><body><p>OK — you can close this tab and return to the terminal.</p></body></html>",
      )
      server.close(() => resolve({ code, state }))
    })
    server.listen(port, "127.0.0.1", () => {
      console.log(`Listening on http://127.0.0.1:${port}${CALLBACK_PATH}`)
    })
    server.on("error", (e) => reject(e))
    setTimeout(() => {
      server.close()
      reject(
        new Error(`Timeout after ${timeoutMs}ms waiting for OAuth callback`),
      )
    }, timeoutMs).unref()
  })
}

async function exchangeCode(params: {
  authBase: string
  clientId: string
  code: string
  redirectUri: string
  codeVerifier: string
  resource?: string
}): Promise<{ status: number; json: TokenResponse }> {
  const tokenUrl = `${authPrefix(params.authBase)}/oauth2/token`
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  }
  if (params.resource) body.resource = params.resource
  const r = await postForm(tokenUrl, body)
  return { status: r.status, json: r.json }
}

async function refreshToken(params: {
  authBase: string
  clientId: string
  refreshToken: string
  resource?: string
}): Promise<{ status: number; json: TokenResponse }> {
  const tokenUrl = `${authPrefix(params.authBase)}/oauth2/token`
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  }
  if (params.resource) body.resource = params.resource
  return postForm(tokenUrl, body).then((r) => ({
    status: r.status,
    json: r.json,
  }))
}

async function mcpInitialize(params: {
  authBase: string
  orgSlug: string
  accessToken: string
}): Promise<{ status: number; body: string }> {
  const url = `${params.authBase}/mcp?orgSlug=${encodeURIComponent(params.orgSlug)}`
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "oauth-refresh-probe", version: "0.0.1" },
    },
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  })
  const body = await res.text()
  return { status: res.status, body: body.slice(0, 2000) }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mcp: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      port: { type: "string", default: String(DEFAULT_CALLBACK_PORT) },
      "replay-refresh": { type: "boolean", default: false },
      "client-id": { type: "string" },
      "refresh-token": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  })

  if (values.help || positionals.includes("-h")) usage()

  const authBase = baseUrl()
  const mcpResource = `${authBase}/mcp`

  if (values["replay-refresh"]) {
    const clientId = values["client-id"]
    const refreshTok = values["refresh-token"]
    if (!clientId || !refreshTok) {
      console.error("--replay-refresh requires --client-id and --refresh-token")
      usage()
    }
    const r1 = await refreshToken({
      authBase,
      clientId,
      refreshToken: refreshTok,
      resource: mcpResource,
    })
    printTokenResult("refresh_token (1)", r1.status, r1.json)
    if (r1.status !== 200 || !r1.json.refresh_token) {
      process.exit(1)
    }
    const r2 = await refreshToken({
      authBase,
      clientId,
      refreshToken: r1.json.refresh_token,
      resource: mcpResource,
    })
    printTokenResult("refresh_token (2, after rotation)", r2.status, r2.json)
    process.exit(r2.status === 200 ? 0 : 1)
  }

  const port = Number.parseInt(values.port ?? String(DEFAULT_CALLBACK_PORT), 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error("Invalid --port")
    process.exit(1)
  }

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const { client_id: clientId } = await registerClient(authBase, redirectUri)

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await sha256B64Url(codeVerifier)
  const state = b64url(randomBytes(16))

  const authorize = new URL(`${authPrefix(authBase)}/oauth2/authorize`)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("client_id", clientId)
  authorize.searchParams.set("redirect_uri", redirectUri)
  authorize.searchParams.set("scope", OAUTH_SCOPE)
  authorize.searchParams.set("state", state)
  authorize.searchParams.set("code_challenge", codeChallenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  authorize.searchParams.set("resource", mcpResource)

  const authUrl = authorize.toString()
  console.log("\nOpen this URL in your browser and sign in:\n")
  console.log(authUrl)
  console.log("")

  if (!values["no-open"]) {
    try {
      openBrowser(authUrl)
      console.log("(Attempted to open default browser.)")
    } catch {
      console.log("(Could not auto-open browser; open the URL manually.)")
    }
  }

  console.log("Waiting for OAuth callback...")
  const { code } = await waitForCallback(port, state, 600_000)

  const tokenRes = await exchangeCode({
    authBase,
    clientId,
    code,
    redirectUri,
    codeVerifier,
    resource: mcpResource,
  })
  printTokenResult("authorization_code → token", tokenRes.status, tokenRes.json)

  if (tokenRes.status !== 200 || !tokenRes.json.refresh_token) {
    console.error("Code exchange failed; cannot test refresh.")
    process.exit(1)
  }

  const refresh1 = await refreshToken({
    authBase,
    clientId,
    refreshToken: tokenRes.json.refresh_token,
    resource: mcpResource,
  })
  printTokenResult("refresh_token (immediate)", refresh1.status, refresh1.json)

  if (refresh1.status === 200 && refresh1.json.refresh_token) {
    const refresh2 = await refreshToken({
      authBase,
      clientId,
      refreshToken: refresh1.json.refresh_token,
      resource: mcpResource,
    })
    printTokenResult(
      "refresh_token (second call, post-rotation)",
      refresh2.status,
      refresh2.json,
    )
  }

  if (values.mcp) {
    const org = process.env.CTXPIPE_ORG_SLUG
    if (!org) {
      console.error(
        "Set CTXPIPE_ORG_SLUG for --mcp (org slug for /mcp?orgSlug=)",
      )
      process.exit(1)
    }
    const bearer =
      refresh1.status === 200 && refresh1.json.access_token
        ? refresh1.json.access_token
        : tokenRes.json.access_token
    if (!bearer) {
      console.error("No access_token for MCP probe")
      process.exit(1)
    }
    const mcpRes = await mcpInitialize({
      authBase,
      orgSlug: org,
      accessToken: bearer,
    })
    console.log(`\n--- MCP initialize (${org}) ---`)
    console.log(`HTTP ${mcpRes.status}`)
    console.log(mcpRes.body)
  }

  const savePath = "oauth-repro.tokens.json"
  try {
    await writeFile(
      savePath,
      `${JSON.stringify(
        {
          client_id: clientId,
          refresh_token:
            refresh1.json.refresh_token ?? tokenRes.json.refresh_token,
          access_token:
            refresh1.json.access_token ?? tokenRes.json.access_token,
          saved_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    console.log(`\nWrote ${savePath} (gitignored) — delete after debugging.`)
  } catch {
    // ignore write failures (e.g. read-only cwd)
  }

  const ok = refresh1.status === 200
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
