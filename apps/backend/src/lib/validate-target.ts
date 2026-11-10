import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/*
 * The smoke checks of a deployed ctxpipe before customers use it (CTX-1217:
 * the AWS stack before the go/no-go, and after each rehearsal). Each check
 * reads only: it changes no row. The `preview-env` sweep and the MCP evals
 * run after these checks pass.
 */

type CheckResult = { name: string; ok: boolean; detail: string }

type TargetOptions = {
  /** The backend origin, for example `https://app.ctxpipe.ai`. */
  baseUrl: string
  /**
   * Headers for each request, for example the Cloudflare Access service
   * token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) of an internal
   * host name.
   */
  headers?: Record<string, string>
  /** A personal API key of a test organization, for the MCP read check. */
  apiKey?: string
  timeoutMs?: number
}

async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Runs the checks against `baseUrl`, in order, and returns each result. A
 * failed check does not stop the next one.
 */
export async function validateTarget(
  options: TargetOptions,
): Promise<CheckResult[]> {
  const base = options.baseUrl.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? 20_000
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...options.headers, ...(init.headers as object) },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    })

  const results: CheckResult[] = []
  results.push(
    await check("status", async () => {
      const response = await request("/.status")
      expect(response.status === 200, `GET /.status gave ${response.status}`)
      const body = (await response.json()) as { status?: unknown }
      expect(body.status === "ok", `the status is ${String(body.status)}`)
      return "ok"
    }),
  )
  results.push(
    await check("ui", async () => {
      const response = await request("/")
      expect(response.status === 200, `GET / gave ${response.status}`)
      const bundle =
        /<script type="module"[^>]* src="(\/assets\/[\w.-]+\.js)"/.exec(
          await response.text(),
        )?.[1]
      expect(Boolean(bundle), "GET / has no module bundle of the UI")
      return `serves ${bundle}`
    }),
  )
  results.push(
    await check("oauth metadata", async () => {
      const response = await request(
        "/.well-known/oauth-protected-resource/mcp",
      )
      expect(response.status === 200, `the metadata gave ${response.status}`)
      const body = (await response.json()) as { resource?: unknown }
      // AUTH_BASE_URL of the backend must be this origin, or MCP clients
      // get tokens for another host.
      expect(
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
            clientInfo: { name: "ctxpipe-validate-target", version: "1" },
          },
        }),
      })
      expect(
        response.status === 401,
        `POST /mcp without a token gave ${response.status}, not 401`,
      )
      const challenge = response.headers.get("www-authenticate") ?? ""
      const metadata = `${base}/.well-known/oauth-protected-resource/mcp`
      expect(
        challenge.includes(`resource_metadata="${metadata}"`),
        `the challenge does not name ${metadata}: ${challenge}`,
      )
      return "401 with the resource metadata of this origin"
    }),
  )
  results.push(
    await check("openapi", async () => {
      const response = await request("/.docs/openapi")
      expect(response.status === 200, `the spec gave ${response.status}`)
      const body = (await response.json()) as { openapi?: unknown }
      expect(
        typeof body.openapi === "string" && body.openapi.startsWith("3.1"),
        `the spec version is ${String(body.openapi)}`,
      )
      return `OpenAPI ${body.openapi}`
    }),
  )
  if (options.apiKey) {
    const apiKey = options.apiKey
    results.push(
      await check("mcp read", async () => {
        const client = new Client({
          name: "ctxpipe-validate-target",
          version: "1",
        })
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: {
              headers: { ...options.headers, "x-api-key": apiKey },
            },
          }),
        )
        try {
          const { tools } = await client.listTools()
          expect(
            tools.some((tool) => tool.name === "list_workspaces"),
            `tools/list has no list_workspaces (${tools.map((tool) => tool.name).join(", ")})`,
          )
          // A read through the database and the auth of the API key.
          const result = await client.callTool({
            name: "list_workspaces",
            arguments: {},
          })
          expect(!result.isError, "list_workspaces gave an error")
          return `${tools.length} tools; list_workspaces answered`
        } finally {
          await client.close()
        }
      }),
    )
  }
  return results
}
