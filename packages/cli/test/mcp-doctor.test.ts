import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMcpDoctor } from "../src/commands.js"
import {
  diagnoseMcpEndpoint,
  formatMcpDoctorResult,
} from "../src/mcp/doctor.js"

const remoteUrl = "https://app.example.com/mcp?orgSlug=acme"

function healthyFetch(
  appOrigin = "https://app.example.com",
  authOrigin = "https://auth.example.com",
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input
    if (url === `${appOrigin}/.status`) {
      return Response.json({ status: "ok" })
    }
    if (url === `${appOrigin}/mcp` || url.startsWith(`${appOrigin}/mcp?`)) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${appOrigin}/.well-known/oauth-protected-resource/mcp"`,
        },
      })
    }
    if (url === `${appOrigin}/.well-known/oauth-protected-resource/mcp`) {
      return Response.json({
        resource: `${appOrigin}/mcp`,
        authorization_servers: [authOrigin],
      })
    }
    if (url === `${authOrigin}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: authOrigin,
        authorization_endpoint: `${authOrigin}/oauth2/authorize`,
        token_endpoint: `${authOrigin}/oauth2/token`,
        registration_endpoint: `${authOrigin}/oauth2/register`,
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }) as typeof fetch
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  const headers = init?.headers
  if (!headers) return {}
  if (headers instanceof Headers) {
    return Object.fromEntries(
      [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
    )
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key.toLowerCase(), String(value)]),
    )
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  )
}

function initializeOkResponse(): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: "ctxpipe-doctor",
    result: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      serverInfo: { name: "ctxpipe", version: "1" },
    },
  })
}

function apiKeyFetch(
  secret: string,
  appOrigin = "https://app.example.com",
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input
    if (url === `${appOrigin}/.status`) {
      return Response.json({ status: "ok" })
    }
    if (url === `${appOrigin}/mcp` || url.startsWith(`${appOrigin}/mcp?`)) {
      const sent = requestHeaders(init)["x-api-key"]
      if (sent === secret) return initializeOkResponse()
      return new Response(null, { status: 401 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

describe("diagnoseMcpEndpoint", () => {
  it("accepts loopback HTTP but reports the transport warning", async () => {
    const fetchFn = healthyFetch("http://localhost:3000")
    const result = await diagnoseMcpEndpoint({
      url: "http://localhost:3000/mcp?orgSlug=acme",
      fetch: fetchFn,
    })

    expect(result.checks[0]).toMatchObject({
      id: "target",
      status: "warn",
    })
    expect(result.status).toBe("warning")
  })

  it("rejects remote HTTP before making requests", async () => {
    const fetchFn = healthyFetch()
    const result = await diagnoseMcpEndpoint({
      url: "http://app.example.com/mcp?orgSlug=acme",
      fetch: fetchFn,
    })

    expect(result.status).toBe("failed")
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "target", status: "fail" }),
    ])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("requires the ctxpipe MCP path and accepts a missing orgSlug", async () => {
    const missingOrg = await diagnoseMcpEndpoint({
      url: "https://app.example.com/mcp",
      fetch: healthyFetch(),
    })
    const wrongPath = await diagnoseMcpEndpoint({
      url: "https://app.example.com/api/mcp?orgSlug=acme",
      fetch: healthyFetch(),
    })

    expect(missingOrg.status).toBe("ready-for-oauth")
    expect(wrongPath.checks[0]?.summary).toContain('"/mcp"')
  })

  it("reports ready-for-oauth for healthy discovery", async () => {
    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: healthyFetch(),
    })

    expect(result.status).toBe("ready-for-oauth")
    expect(result.checks).toHaveLength(5)
    expect(result.checks.every((check) => check.status === "pass")).toBe(true)
    expect(result.nextSteps.join(" ")).toContain("MCPJam")
  })

  it("fails a malformed Bearer challenge without fetching metadata", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.endsWith("/.status")) return Response.json({ status: "ok" })
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer realm=ctxpipe" },
      })
    })

    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: fetchFn,
    })

    expect(result.status).toBe("failed")
    expect(
      result.checks.find((check) => check.id === "oauth-challenge"),
    ).toMatchObject({ status: "fail" })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("continues OAuth discovery when the status endpoint is unreachable", async () => {
    const baseFetch = healthyFetch()
    const fetchFn = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (input.toString().endsWith("/.status")) {
          throw new Error("connection refused")
        }
        return baseFetch(input, init)
      },
    )

    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: fetchFn,
    })

    expect(result.status).toBe("failed")
    expect(
      result.checks.find((check) => check.id === "backend-status"),
    ).toMatchObject({ status: "fail" })
    expect(
      result.checks.find(
        (check) => check.id === "authorization-server-metadata",
      ),
    ).toMatchObject({ status: "pass" })
  })

  it("fails inconsistent protected-resource metadata", async () => {
    const baseFetch = healthyFetch()
    const fetchFn = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (
          input.toString().includes("/.well-known/oauth-protected-resource/")
        ) {
          return Response.json({
            resource: "https://wrong.example.com/mcp",
            authorization_servers: [],
          })
        }
        return baseFetch(input, init)
      },
    )

    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: fetchFn,
    })

    expect(
      result.checks.find((check) => check.id === "protected-resource-metadata"),
    ).toMatchObject({ status: "fail" })
  })

  it("fails authorisation-server metadata that omits registration", async () => {
    const baseFetch = healthyFetch()
    const fetchFn = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (
          input.toString().includes("/.well-known/oauth-authorization-server")
        ) {
          return Response.json({
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/oauth2/authorize",
            token_endpoint: "https://auth.example.com/oauth2/token",
          })
        }
        return baseFetch(input, init)
      },
    )

    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: fetchFn,
    })

    expect(
      result.checks.find(
        (check) => check.id === "authorization-server-metadata",
      ),
    ).toMatchObject({ status: "fail" })
  })

  it("reports request timeouts", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        }),
    )

    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      timeoutMs: 5,
      fetch: fetchFn,
    })

    expect(result.status).toBe("failed")
    expect(
      result.checks.some((check) => check.summary.includes("timed out")),
    ).toBe(true)
  })

  it("sends x-api-key and reports ready-for-api-key on 2xx initialize", async () => {
    const secret = "ctxp_doctor_secret"
    const fetchFn = apiKeyFetch(secret)
    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: fetchFn,
      apiKey: secret,
    })
    const output = `${JSON.stringify(result)}\n${formatMcpDoctorResult(result)}`

    expect(result.status).toBe("ready-for-api-key")
    expect(result.checks.map((check) => check.id)).toEqual([
      "target",
      "backend-status",
      "api-key-initialize",
    ])
    expect(
      result.checks.find((check) => check.id === "api-key-initialize"),
    ).toMatchObject({ status: "pass" })
    expect(result.nextSteps.join(" ")).toContain("x-api-key")
    expect(output).not.toContain(secret)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const initializeCall = fetchFn.mock.calls.find(([input]) =>
      String(input).includes("/mcp"),
    )
    expect(requestHeaders(initializeCall?.[1])).toMatchObject({
      "x-api-key": secret,
    })
  })

  it("fails API-key initialize that is not HTTP 2xx and skips OAuth discovery", async () => {
    const secret = "ctxp_wrong_key"
    const fetchFn = apiKeyFetch("ctxp_expected_key")
    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: fetchFn,
      apiKey: secret,
    })
    const output = `${JSON.stringify(result)}\n${formatMcpDoctorResult(result)}`

    expect(result.status).toBe("failed")
    expect(
      result.checks.find((check) => check.id === "api-key-initialize"),
    ).toMatchObject({ status: "fail" })
    expect(result.checks.some((check) => check.id === "oauth-challenge")).toBe(
      false,
    )
    expect(output).not.toContain(secret)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("treats a blank apiKey as unset and keeps OAuth discovery", async () => {
    const result = await diagnoseMcpEndpoint({
      url: remoteUrl,
      fetch: healthyFetch(),
      apiKey: "   ",
    })

    expect(result.status).toBe("ready-for-oauth")
    expect(result.checks).toHaveLength(5)
    expect(
      result.checks.some((check) => check.id === "api-key-initialize"),
    ).toBe(false)
  })

  it("redacts unrelated target query values from JSON and human output", async () => {
    const result = await diagnoseMcpEndpoint({
      url: `${remoteUrl}&access_token=secret-value`,
      fetch: healthyFetch(),
    })
    const output = `${JSON.stringify(result)}\n${formatMcpDoctorResult(result)}`

    expect(output).not.toContain("secret-value")
    expect(output).not.toContain("access_token")
  })
})

describe("runMcpDoctor", () => {
  beforeEach(() => {
    vi.stubEnv("CTXPIPE_API_KEY", "")
  })

  it("sets a failing exit code and emits valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await runMcpDoctor({
      url: remoteUrl,
      timeoutMs: 10,
      json: true,
    })

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      status: string
      checks: unknown
    }
    expect(parsed.status).toBe("failed")
    expect(Array.isArray(parsed.checks)).toBe(true)
  })

  it("leaves the exit code unset when discovery is healthy", async () => {
    vi.stubGlobal("fetch", healthyFetch())
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    await runMcpDoctor({
      url: remoteUrl,
      timeoutMs: 10,
      json: true,
    })

    expect(process.exitCode).toBeUndefined()
  })

  it("sends x-api-key from CTXPIPE_API_KEY in the doctor process", async () => {
    const secret = "ctxp_must_not_be_printed"
    vi.stubEnv("CTXPIPE_API_KEY", secret)
    const fetchFn = apiKeyFetch(secret)
    vi.stubGlobal("fetch", fetchFn)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await runMcpDoctor({
      url: remoteUrl,
      timeoutMs: 10,
      json: true,
    })

    expect(process.exitCode).toBeUndefined()
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      status: string
    }
    expect(parsed.status).toBe("ready-for-api-key")
    expect(String(log.mock.calls[0]?.[0])).not.toContain(secret)
    const initializeCall = fetchFn.mock.calls.find(([input]) =>
      String(input).includes("/mcp"),
    )
    expect(requestHeaders(initializeCall?.[1])).toMatchObject({
      "x-api-key": secret,
    })
  })
})
