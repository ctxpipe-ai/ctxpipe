import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AuthRequestError,
  fetchOrganizations,
  fetchSession,
  isAuthReauthenticationRequired,
} from "../src/auth.js"

describe("CLI auth HTTP handling", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("retries transient organisation-list failures", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "org_1", name: "Acme", slug: "acme" }],
        }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const resultPromise = fetchOrganizations({
      baseUrl: "https://app.ctxpipe.ai",
      accessToken: "token",
    })
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toEqual([
      { id: "org_1", name: "Acme", slug: "acme" },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("reports an exhausted empty 500 as a temporary server error", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)

    const resultPromise = fetchOrganizations({
      baseUrl: "https://app.ctxpipe.ai",
      accessToken: "token",
    })
    const rejection = expect(resultPromise).rejects.toMatchObject({
      status: 500,
      temporary: true,
      message: "ctx| auth returned HTTP 500 (server error, try again shortly)",
    })
    await vi.runAllTimersAsync()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("retries a rate-limited idempotent auth request", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "rate_limited" }, { status: 429 }),
      )
      .mockResolvedValueOnce(Response.json({ data: [] }))
    vi.stubGlobal("fetch", fetchMock)

    const resultPromise = fetchOrganizations({
      baseUrl: "https://app.ctxpipe.ai",
      accessToken: "token",
    })
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("classifies only 401 and 403 as requiring sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "invalid_token", message: "Token expired" },
            { status: 401 },
          ),
        ),
    )

    const error = await fetchSession({
      baseUrl: "https://app.ctxpipe.ai",
      accessToken: "expired",
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthRequestError)
    expect(isAuthReauthenticationRequired(error)).toBe(true)
  })

  it("does not hide an invalid successful JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>not json</html>", { status: 200 }),
        ),
    )

    await expect(
      fetchSession({
        baseUrl: "https://app.ctxpipe.ai",
        accessToken: "token",
      }),
    ).rejects.toThrow("ctx| auth returned invalid JSON (HTTP 200)")
  })
})
