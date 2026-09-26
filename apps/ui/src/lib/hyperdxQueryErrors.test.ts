import HyperDX from "@hyperdx/browser"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createHyperDxQueryClient,
  hyperDxQueryKeyName,
} from "./hyperdxQueryErrors"

// Same SDK boundary as hyperdxBrowser.test.ts: `recordException` is spied on
// the real singleton. The browser SDK has no in-memory transport.

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
    expect(
      hyperDxQueryKeyName(["Invitation not found or expired"]),
    ).toBeUndefined()
    expect(hyperDxQueryKeyName([{ path: "/secret?token=1" }])).toBeUndefined()
    expect(hyperDxQueryKeyName([])).toBeUndefined()
  })
})

describe("createHyperDxQueryClient", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("records a final query failure once and ignores retries", async () => {
    const recordException = vi.spyOn(HyperDX, "recordException")
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
    expect(recordException).toHaveBeenCalledTimes(1)
    expect(recordException).toHaveBeenCalledWith(error, {
      "ctxpipe.ui.source": "query",
      "ctxpipe.ui.key": "public-invitation-details",
      "ctxpipe.ui.http_status": "404",
    })
  })

  it("records a final mutation failure once", async () => {
    const recordException = vi.spyOn(HyperDX, "recordException")
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
    expect(recordException).toHaveBeenCalledTimes(1)
    expect(recordException).toHaveBeenCalledWith(error, {
      "ctxpipe.ui.source": "mutation",
      "ctxpipe.ui.key": "device-code",
      "ctxpipe.ui.http_status": "400",
    })
  })

  it("skips cancellations and unsafe key names", async () => {
    const recordException = vi.spyOn(HyperDX, "recordException")
    const client = createHyperDxQueryClient()
    const aborted = new DOMException("The operation was aborted", "AbortError")
    await expect(
      client.fetchQuery({
        queryKey: ["conversation", "conv_secret"],
        retry: false,
        queryFn: () => {
          throw aborted
        },
      }),
    ).rejects.toThrow(aborted)

    const cancelled = Object.assign(new Error("cancelled"), {
      name: "CancelledError",
    })
    await expect(
      client.fetchQuery({
        queryKey: ["accept-invitation"],
        retry: false,
        queryFn: () => {
          throw cancelled
        },
      }),
    ).rejects.toThrow(cancelled)

    const unsafe = new Error("Invitation not found or expired")
    await expect(
      client.fetchQuery({
        queryKey: ["user@example.com"],
        retry: false,
        queryFn: () => {
          throw unsafe
        },
      }),
    ).rejects.toThrow(unsafe)

    expect(recordException).toHaveBeenCalledTimes(1)
    expect(recordException).toHaveBeenCalledWith(unsafe, {
      "ctxpipe.ui.source": "query",
    })
  })
})
