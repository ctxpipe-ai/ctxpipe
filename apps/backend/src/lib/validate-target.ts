import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { formatUnknownError } from "../db/transientDbRetry.js"

/*
 * The smoke checks of a deployed ctxpipe before customers use it (CTX-1217:
 * the AWS stack before the go/no-go, and after each rehearsal). The checks
 * change no customer row. The only database write is the request counter of
 * the test API key (Better Auth), which the `mcp read` check uses. The
 * `preview-env` sweep and the MCP evals run after these checks pass.
 *
 * In each phase of the cutover, the target origin is the AUTH_BASE_URL of the
 * stack. Before the window (the empty database and each rehearsal), it is
 * `https://cutover.ctxpipe.dev`. In the window, it is `https://app.ctxpipe.ai`.
 * Thus the OAuth checks compare the advertised resource with the target origin.
 */

type CheckResult = { name: string; ok: boolean; detail: string }

type TargetOptions = {
  /**
   * The backend origin, for example `https://app.ctxpipe.ai`. It must use
   * HTTPS, except on a loopback host.
   */
  baseUrl: string
  /**
   * Headers for each request, for example the Cloudflare Access service
   * token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) of an internal
   * host name.
   */
  headers?: Record<string, string>
  /**
   * A personal API key of a test organization, for the `mcp read` check.
   * Without it, that check fails, unless `skipMcpRead` is true.
   */
  apiKey?: string
  /** Do not do the `mcp read` check, for example on an empty database. */
  skipMcpRead?: boolean
}

async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() }
  } catch (error) {
    return { name, ok: false, detail: formatUnknownError(error) }
  }
}

function assertCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Runs the checks against `baseUrl`, in order, and returns each result. A
 * failed check does not stop the next one. The requests send credentials, so
 * it throws before the first request when `baseUrl` is plain HTTP on a host
 * that is not loopback.
 */
export async function validateTarget(
  options: TargetOptions,
): Promise<CheckResult[]> {
  const target = new URL(options.baseUrl)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  if (
    target.protocol !== "https:" &&
    !(target.protocol === "http:" && loopback)
  )
    throw new Error(
      `Give an https:// origin (http:// only on a loopback host), not ${target.origin}`,
    )
  const base = target.origin
  const metadataPath = "/.well-known/oauth-protected-resource/mcp"
  const clientInfo = { name: "ctxpipe-validate-target", version: "1" }

  // Each request has a timeout and follows no redirect. A redirect to another
  // host would send the credentials in the headers to that host.
  const send = async (url: string | URL, init: RequestInit = {}) => {
    const timeout = AbortSignal.timeout(20_000)
    const response = await fetch(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      redirect: "manual",
    })
    assertCheck(
      response.status < 300 || response.status > 399,
      `${init.method ?? "GET"} ${new URL(url).pathname} gave the redirect ${response.status}. The checks follow no redirect.`,
    )
    return response
  }
  const request = (
    path: string,
    init: Omit<RequestInit, "headers"> & {
      headers?: Record<string, string>
    } = {},
  ) =>
    send(`${base}${path}`, {
      ...init,
      headers: { ...options.headers, ...init.headers },
    })

  const results: CheckResult[] = []
  results.push(
    await check("status", async () => {
      const response = await request("/.status")
      assertCheck(
        response.status === 200,
        `GET /.status gave ${response.status}`,
      )
      const body = (await response.json()) as { status?: unknown }
      assertCheck(body.status === "ok", `the status is ${String(body.status)}`)
      return "ok"
    }),
  )
  results.push(
    await check("ui", async () => {
      const response = await request("/")
      assertCheck(response.status === 200, `GET / gave ${response.status}`)
      const bundle =
        /<script type="module"[^>]* src="(\/assets\/[\w.-]+\.js)"/.exec(
          await response.text(),
        )?.[1]
      assertCheck(Boolean(bundle), "GET / has no module bundle of the UI")
      return `serves ${bundle}`
    }),
  )
  results.push(
    await check("oauth metadata", async () => {
      const response = await request(metadataPath)
      assertCheck(
        response.status === 200,
        `the metadata gave ${response.status}`,
      )
      const body = (await response.json()) as { resource?: unknown }
      // AUTH_BASE_URL of the backend must be this origin, or MCP clients
      // get tokens for another host.
      assertCheck(
        body.resource === `${base}/mcp`,
        `the resource is ${String(body.resource)}, not ${base}/mcp. Set AUTH_BASE_URL to ${base}.`,
      )
      return `resource ${body.resource}`
    }),
  )
  results.push(
    await check("mcp challenge", async () => {
      const response = await request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo,
          },
        }),
      })
      assertCheck(
        response.status === 401,
        `POST /mcp without a token gave ${response.status}, not 401`,
      )
      const challenge = response.headers.get("www-authenticate") ?? ""
      const metadata = `${base}${metadataPath}`
      assertCheck(
        challenge.includes(`resource_metadata="${metadata}"`),
        `the challenge does not name ${metadata}: ${challenge}`,
      )
      return "401 with the resource metadata of this origin"
    }),
  )
  results.push(
    await check("openapi", async () => {
      const response = await request("/.docs/openapi")
      assertCheck(response.status === 200, `the spec gave ${response.status}`)
      const body = (await response.json()) as { openapi?: unknown }
      assertCheck(
        typeof body.openapi === "string" && body.openapi.startsWith("3.1"),
        `the spec version is ${String(body.openapi)}`,
      )
      return `OpenAPI ${body.openapi}`
    }),
  )
  if (!options.skipMcpRead) {
    const apiKey = options.apiKey
    results.push(
      await check("mcp read", async () => {
        if (!apiKey)
          throw new Error(
            "No API key. Set VALIDATE_API_KEY to a personal API key of a test organization, or give --no-mcp-read.",
          )
        const client = new Client(clientInfo)
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            fetch: send,
            requestInit: {
              headers: { ...options.headers, "x-api-key": apiKey },
            },
          }),
        )
        try {
          const { tools } = await client.listTools()
          assertCheck(
            tools.some((tool) => tool.name === "list_workspaces"),
            `tools/list has no list_workspaces (${tools.map((tool) => tool.name).join(", ")})`,
          )
          // A read through the database and the auth of the API key.
          const result = await client.callTool({
            name: "list_workspaces",
            arguments: {},
          })
          assertCheck(!result.isError, "list_workspaces gave an error")
          return `${tools.length} tools; list_workspaces answered`
        } finally {
          await client.close()
        }
      }),
    )
  }
  return results
}
