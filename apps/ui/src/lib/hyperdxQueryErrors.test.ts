import { afterEach, describe, expect, it, vi } from "vitest"

const { recordHyperDxException } = vi.hoisted(() => ({
  recordHyperDxException: vi.fn(),
}))

vi.mock("@/lib/hyperdxBrowser", () => ({
  recordHyperDxException,
}))

import {
  createHyperDxQueryClient,
  hyperDxQueryKeyName,
  recordHyperDxQueryError,
  setHyperDxExceptionRecordingEnabled,
} from "./hyperdxQueryErrors"

describe("hyperDxQueryKeyName", () => {
  it("keeps a static first segment and drops ids and free text", () => {
    expect(
      hyperDxQueryKeyName([
        "public-invitation-details",
        "inv_not_real",
        "user@example.com",
      ]),
    ).toBe("public-invitation-details")
    expect(hyperDxQueryKeyName(["conversation", "org_1", "conv_abc"])).toBe(
      "conversation",
    )
    expect(hyperDxQueryKeyName(["user@example.com"])).toBeUndefined()
    expect(hyperDxQueryKeyName(["inv_not_real"])).toBeUndefined()
    expect(
      hyperDxQueryKeyName(["550e8400-e29b-41d4-a716-446655440000"]),
    ).toBeUndefined()
    expect(hyperDxQueryKeyName(["Invitation not found or expired"])).toBeUndefined()
    expect(hyperDxQueryKeyName([{ path: "/secret?token=1" }])).toBeUndefined()
    expect(hyperDxQueryKeyName([])).toBeUndefined()
  })
})

describe("recordHyperDxQueryError", () => {
  afterEach(() => {
    recordHyperDxException.mockClear()
    setHyperDxExceptionRecordingEnabled(false)
  })

  it("records a final query failure once and ignores retries", async () => {
    setHyperDxExceptionRecordingEnabled(true)
    const client = createHyperDxQueryClient()
    let attempts = 0
    const error = Object.assign(new Error("Invitation not found or expired"), {
      status: 404,
    })
    await expect(
      client.fetchQuery({
        queryKey: ["public-invitation-details", "inv_not_real"],
        retry: 2,
        retryDelay: 0,
        queryFn: () => {
          attempts += 1
          throw error
        },
      }),
    ).rejects.toThrow(error)

    expect(attempts).toBe(3)
    expect(recordHyperDxException).toHaveBeenCalledTimes(1)
    expect(recordHyperDxException).toHaveBeenCalledWith(error, {
      "ctxpipe.ui.source": "query",
      "ctxpipe.ui.key": "public-invitation-details",
      "ctxpipe.ui.http_status": "404",
    })
  })

  it("records a final mutation failure once", async () => {
    setHyperDxExceptionRecordingEnabled(true)
    const client = createHyperDxQueryClient()
    let attempts = 0
    const error = Object.assign(new Error("Invalid or expired code"), {
      response: { status: 400 },
    })
    const mutation = client.getMutationCache().build(client, {
      mutationKey: ["device-code", "BADCODE"],
      retry: 1,
      retryDelay: 0,
      mutationFn: async () => {
        attempts += 1
        throw error
      },
    })

    await expect(mutation.execute(undefined)).rejects.toThrow(error)
    expect(attempts).toBe(2)
    expect(recordHyperDxException).toHaveBeenCalledTimes(1)
    expect(recordHyperDxException).toHaveBeenCalledWith(error, {
      "ctxpipe.ui.source": "mutation",
      "ctxpipe.ui.key": "device-code",
      "ctxpipe.ui.http_status": "400",
    })
  })

  it("ignores abort and cancellation", () => {
    setHyperDxExceptionRecordingEnabled(true)
    recordHyperDxQueryError({
      source: "query",
      error: new DOMException("The operation was aborted", "AbortError"),
      key: ["conversation", "conv_secret"],
    })
    recordHyperDxQueryError({
      source: "mutation",
      error: Object.assign(new Error("cancelled"), { name: "CancelledError" }),
      key: ["accept-invitation"],
    })
    expect(recordHyperDxException).not.toHaveBeenCalled()
  })

  it("does nothing when browser RUM is disabled", async () => {
    setHyperDxExceptionRecordingEnabled(false)
    const client = createHyperDxQueryClient()
    await expect(
      client.fetchQuery({
        queryKey: ["public-invitation-details"],
        retry: false,
        queryFn: () => {
          throw new Error("Invitation not found or expired")
        },
      }),
    ).rejects.toThrow("Invitation not found or expired")
    expect(recordHyperDxException).not.toHaveBeenCalled()
  })
})
