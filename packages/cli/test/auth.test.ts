import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AuthRequestError,
  fetchOrganizations,
  fetchSession,
  isAccessTokenExpired,
  isAuthReauthenticationRequired,
  pollDeviceToken,
  requestDeviceCode,
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

  it("does not retry non-idempotent device-code issuance", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      requestDeviceCode("https://app.ctxpipe.ai"),
    ).rejects.toMatchObject({
      status: 503,
      temporary: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps polling through a temporary device-token outage", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ error: "authorization_pending" }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "approved", token_type: "Bearer" }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const resultPromise = pollDeviceToken({
      baseUrl: "https://app.ctxpipe.ai",
      deviceCode: "device-code",
      interval: 1,
    })
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toMatchObject({
      access_token: "approved",
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("reports a consumed device code after an ambiguous lost response", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const resultPromise = pollDeviceToken({
      baseUrl: "https://app.ctxpipe.ai",
      deviceCode: "device-code",
      interval: 1,
    })
    const rejection = expect(resultPromise).rejects.toThrow(
      "sign-in approval could not be recovered",
    )
    await vi.runAllTimersAsync()
    await rejection
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

  it("treats an expired device-flow token as signed out", () => {
    expect(
      isAccessTokenExpired({
        baseUrl: "https://app.ctxpipe.ai",
        accessToken: "token",
        refreshToken: null,
        tokenType: "Bearer",
        expiresAt: "2020-01-01T00:00:00.000Z",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe(true)
    expect(
      isAccessTokenExpired({
        baseUrl: "https://app.ctxpipe.ai",
        accessToken: "token",
        refreshToken: null,
        tokenType: "Bearer",
        expiresAt: null,
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe(false)
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
