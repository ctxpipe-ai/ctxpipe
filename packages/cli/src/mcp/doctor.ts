export type McpDoctorCheckStatus = "pass" | "warn" | "fail"

export type McpDoctorCheck = {
  id:
    | "target"
    | "backend-status"
    | "oauth-challenge"
    | "protected-resource-metadata"
    | "authorization-server-metadata"
  status: McpDoctorCheckStatus
  summary: string
}

export type McpDoctorResult = {
  status: "ready-for-oauth" | "warning" | "failed"
  target: string
  checks: McpDoctorCheck[]
  nextSteps: string[]
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type DiagnoseMcpEndpointOptions = {
  url: string
  timeoutMs?: number
  fetch?: FetchLike
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  )
}

function displayTarget(target: URL): string {
  const orgSlug = target.searchParams.get("orgSlug")
  const display = new URL(target.origin)
  display.pathname = target.pathname
  if (orgSlug) display.searchParams.set("orgSlug", orgSlug)
  return display.toString()
}

function protectedResourceMetadataFromChallenge(
  challenge: string | null,
): string | null {
  if (!challenge) return null
  const match = challenge.match(
    /resource_metadata=(?:"((?:\\.|[^"])*)"|([^,\s]+))/i,
  )
  const value = match?.[1] ?? match?.[2]
  if (!value) return null
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

function authorizationServerMetadataUrl(issuer: string): URL {
  const issuerUrl = new URL(issuer)
  const issuerPath =
    issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "")
  issuerUrl.pathname = `/.well-known/oauth-authorization-server${issuerPath}`
  issuerUrl.search = ""
  issuerUrl.hash = ""
  return issuerUrl
}

function isSecureHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    )
  } catch {
    return false
  }
}

async function fetchWithTimeout(
  fetchFn: FetchLike,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    return await fetchFn(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function resultFromChecks(
  target: string,
  checks: McpDoctorCheck[],
): McpDoctorResult {
  const status = checks.some((check) => check.status === "fail")
    ? "failed"
    : checks.some((check) => check.status === "warn")
      ? "warning"
      : "ready-for-oauth"
  return {
    status,
    target,
    checks,
    nextSteps:
      status === "failed"
        ? [
            "Fix the failed endpoint or discovery checks, then run this command again.",
          ]
        : [
            "Complete OAuth in an MCP client to prove authenticated access.",
            "Use MCPJam for an OAuth trace, tools/list, and a test ctx_advisor call.",
          ],
  }
}

export async function diagnoseMcpEndpoint(
  options: DiagnoseMcpEndpointOptions,
): Promise<McpDoctorResult> {
  const checks: McpDoctorCheck[] = []
  const timeoutMs = options.timeoutMs ?? 10_000
  const fetchFn = options.fetch ?? fetch

  let target: URL
  try {
    target = new URL(options.url)
  } catch {
    checks.push({
      id: "target",
      status: "fail",
      summary: "Target is not a valid URL.",
    })
    return resultFromChecks("[invalid URL]", checks)
  }

  const targetDisplay = displayTarget(target)
  const orgSlug = target.searchParams.get("orgSlug")?.trim()
  if (!["http:", "https:"].includes(target.protocol)) {
    checks.push({
      id: "target",
      status: "fail",
      summary: "Target must use HTTP or HTTPS.",
    })
    return resultFromChecks(targetDisplay, checks)
  }
  if (target.pathname !== "/mcp") {
    checks.push({
      id: "target",
      status: "fail",
      summary: 'Target path must be "/mcp".',
    })
    return resultFromChecks(targetDisplay, checks)
  }
  if (!orgSlug) {
    checks.push({
      id: "target",
      status: "fail",
      summary: "Target is missing the required orgSlug query parameter.",
    })
    return resultFromChecks(targetDisplay, checks)
  }
  if (target.protocol === "http:" && !isLoopbackHostname(target.hostname)) {
    checks.push({
      id: "target",
      status: "fail",
      summary: "Remote MCP endpoints must use HTTPS.",
    })
    return resultFromChecks(targetDisplay, checks)
  }
  checks.push({
    id: "target",
    status: target.protocol === "http:" ? "warn" : "pass",
    summary:
      target.protocol === "http:"
        ? "Loopback HTTP target is valid for local testing."
        : "HTTPS target and organisation scope are valid.",
  })

  const statusUrl = new URL("/.status", target)
  try {
    const response = await fetchWithTimeout(
      fetchFn,
      statusUrl,
      { headers: { accept: "application/json" } },
      timeoutMs,
    )
    const body = await responseJson(response)
    const healthy =
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      "status" in body &&
      body.status === "ok"
    checks.push({
      id: "backend-status",
      status: healthy ? "pass" : "fail",
      summary: healthy
        ? "Backend status endpoint is healthy."
        : `Backend status check returned HTTP ${response.status} or an unexpected body.`,
    })
  } catch (error) {
    checks.push({
      id: "backend-status",
      status: "fail",
      summary:
        error instanceof Error && error.name === "AbortError"
          ? `Backend status check timed out after ${timeoutMs} ms.`
          : "Backend status endpoint is unreachable.",
    })
  }

  let metadataUrl: URL | null = null
  try {
    const response = await fetchWithTimeout(
      fetchFn,
      target,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ctxpipe-doctor",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "ctxpipe-doctor", version: "1" },
          },
        }),
      },
      timeoutMs,
    )
    const challenge = response.headers.get("www-authenticate")
    const metadata = protectedResourceMetadataFromChallenge(challenge)
    if (response.status !== 401) {
      checks.push({
        id: "oauth-challenge",
        status: "fail",
        summary: `Unauthenticated initialize returned HTTP ${response.status}; expected 401.`,
      })
    } else if (!challenge?.toLowerCase().startsWith("bearer")) {
      checks.push({
        id: "oauth-challenge",
        status: "fail",
        summary: "HTTP 401 response is missing a Bearer challenge.",
      })
    } else if (!metadata || !isSecureHttpUrl(metadata)) {
      checks.push({
        id: "oauth-challenge",
        status: "fail",
        summary:
          "Bearer challenge is missing an absolute resource_metadata URL.",
      })
    } else {
      metadataUrl = new URL(metadata)
      checks.push({
        id: "oauth-challenge",
        status: "pass",
        summary: "MCP endpoint returned the expected OAuth Bearer challenge.",
      })
    }
  } catch (error) {
    checks.push({
      id: "oauth-challenge",
      status: "fail",
      summary:
        error instanceof Error && error.name === "AbortError"
          ? `MCP initialize probe timed out after ${timeoutMs} ms.`
          : "MCP initialize probe is unreachable.",
    })
  }

  let authorizationServers: string[] = []
  if (metadataUrl) {
    try {
      const response = await fetchWithTimeout(
        fetchFn,
        metadataUrl,
        { headers: { accept: "application/json" } },
        timeoutMs,
      )
      const body = await responseJson(response)
      const resource =
        typeof body === "object" &&
        body !== null &&
        "resource" in body &&
        typeof body.resource === "string"
          ? body.resource
          : null
      authorizationServers =
        typeof body === "object" &&
        body !== null &&
        "authorization_servers" in body &&
        Array.isArray(body.authorization_servers)
          ? body.authorization_servers.filter(isSecureHttpUrl)
          : []
      const expectedResource = new URL("/mcp", target).toString()
      const valid =
        response.ok &&
        resource === expectedResource &&
        authorizationServers.length > 0
      checks.push({
        id: "protected-resource-metadata",
        status: valid ? "pass" : "fail",
        summary: valid
          ? "Protected-resource metadata has the expected audience and authorisation server."
          : "Protected-resource metadata is unavailable or inconsistent with the MCP audience.",
      })
    } catch (error) {
      checks.push({
        id: "protected-resource-metadata",
        status: "fail",
        summary:
          error instanceof Error && error.name === "AbortError"
            ? `Protected-resource metadata timed out after ${timeoutMs} ms.`
            : "Protected-resource metadata is unreachable.",
      })
    }
  } else {
    checks.push({
      id: "protected-resource-metadata",
      status: "fail",
      summary: "Protected-resource metadata could not be discovered.",
    })
  }

  if (authorizationServers.length > 0) {
    try {
      const discoveryUrl = authorizationServerMetadataUrl(
        authorizationServers[0] as string,
      )
      const response = await fetchWithTimeout(
        fetchFn,
        discoveryUrl,
        { headers: { accept: "application/json" } },
        timeoutMs,
      )
      const body = await responseJson(response)
      const valid =
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        "issuer" in body &&
        body.issuer === authorizationServers[0] &&
        "authorization_endpoint" in body &&
        isSecureHttpUrl(body.authorization_endpoint) &&
        "token_endpoint" in body &&
        isSecureHttpUrl(body.token_endpoint) &&
        "registration_endpoint" in body &&
        isSecureHttpUrl(body.registration_endpoint)
      checks.push({
        id: "authorization-server-metadata",
        status: valid ? "pass" : "fail",
        summary: valid
          ? "Authorisation-server metadata exposes OAuth and dynamic registration endpoints."
          : "Authorisation-server metadata is missing required OAuth or registration endpoints.",
      })
    } catch (error) {
      checks.push({
        id: "authorization-server-metadata",
        status: "fail",
        summary:
          error instanceof Error && error.name === "AbortError"
            ? `Authorisation-server metadata timed out after ${timeoutMs} ms.`
            : "Authorisation-server metadata is unreachable.",
      })
    }
  } else {
    checks.push({
      id: "authorization-server-metadata",
      status: "fail",
      summary: "No authorisation server was available for discovery.",
    })
  }

  return resultFromChecks(targetDisplay, checks)
}

export function formatMcpDoctorResult(result: McpDoctorResult): string {
  const lines = [`ctx| MCP doctor`, `Target: ${result.target}`, ""]
  for (const check of result.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(4)} ${check.summary}`)
  }
  lines.push("", `Result: ${result.status}`)
  for (const step of result.nextSteps) lines.push(`Next: ${step}`)
  return lines.join("\n")
}
