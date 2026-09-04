import { describe, expect, it } from "vitest"
import {
  captureAuthApiErrors,
  recordAuthApiError,
  transientAuthUnavailableResponse,
} from "./transient-api-error.js"

describe("captureAuthApiErrors", () => {
  it("returns the stable retryable auth failure contract", async () => {
    const response = transientAuthUnavailableResponse()

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("3")
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
      message:
        "ctx| authentication is temporarily unavailable. Try again shortly.",
    })
  })

  it("captures a transient database error reported by Better Auth", async () => {
    const outcome = await captureAuthApiErrors(async () => {
      recordAuthApiError(
        Object.assign(new Error("connection timed out"), {
          code: "ETIMEDOUT",
        }),
      )
      return new Response(null, { status: 500 })
    })

    expect(outcome).toMatchObject({
      ok: true,
      transientDatabaseError: expect.stringContaining("ETIMEDOUT"),
    })
  })

  it("captures a transient database error thrown by the handler", async () => {
    const outcome = await captureAuthApiErrors(async () => {
      throw new Error("Connection terminated unexpectedly")
    })

    expect(outcome).toMatchObject({
      ok: false,
      transientDatabaseError: "Connection terminated unexpectedly",
    })
  })

  it("does not misclassify ordinary API errors as database failures", async () => {
    const forbidden = new Error("Forbidden")
    const outcome = await captureAuthApiErrors(async () => {
      throw forbidden
    })

    expect(outcome).toEqual({
      ok: false,
      error: forbidden,
      transientDatabaseError: null,
    })
  })
})
