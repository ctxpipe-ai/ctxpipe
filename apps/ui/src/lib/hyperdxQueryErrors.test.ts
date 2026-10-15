import HyperDX from "@hyperdx/browser"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest"
import { readApiJson } from "./api-result"
import { recordHyperDxScreenError } from "./hyperdxBrowser"
import {
  createHyperDxQueryClient,
  hyperDxQueryKeyName,
} from "./hyperdxQueryErrors"

// Same SDK boundary as hyperdxBrowser.test.ts: `recordException` is spied on
// the real singleton. The browser SDK has no in-memory transport.

let recordException: MockInstance<(typeof HyperDX)["recordException"]>
let addAction: MockInstance<(typeof HyperDX)["addAction"]>

beforeEach(() => {
  recordException = vi.spyOn(HyperDX, "recordException")
  addAction = vi.spyOn(HyperDX, "addAction")
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("hyperDxQueryKeyName", () => {
  it("returns the first segment when it is a string", () => {
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
    expect(hyperDxQueryKeyName([{ path: "/secret?token=1" }])).toBeUndefined()
    expect(hyperDxQueryKeyName([])).toBeUndefined()
  })
})

describe("createHyperDxQueryClient", () => {
  it("names the failed request on the exception of an API error", async () => {
    const client = createHyperDxQueryClient()
    const response = Response.json(
      { error: "Workspace graph projection is unavailable." },
      { status: 503, headers: { "x-request-id": "req_graph_1" } },
    )
    await expect(
      client.fetchQuery({
        queryKey: ["workspace-graph"],
        retry: false,
        queryFn: () => readApiJson(response),
      }),
    ).rejects.toThrow("Workspace graph projection is unavailable.")

    expect(recordException).toHaveBeenCalledWith(expect.anything(), {
      "ctxpipe.ui.source": "query",
      "ctxpipe.ui.key": "workspace-graph",
      "ctxpipe.ui.http_status": "503",
      "request.id": "req_graph_1",
    })
  })

  it("records a final query failure once and ignores retries", async () => {
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
    const client = createHyperDxQueryClient()
    let attempts = 0
    const error = Object.assign(new Error("Invalid or expired code"), {
      status: 400,
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

  it("skips cancellations and still records a string key", async () => {
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

    const named = new Error("Invitation not found or expired")
    await expect(
      client.fetchQuery({
        queryKey: ["public-invitation-details"],
        retry: false,
        queryFn: () => {
          throw named
        },
      }),
    ).rejects.toThrow(named)

    expect(recordException).toHaveBeenCalledTimes(1)
    expect(recordException).toHaveBeenCalledWith(named, {
      "ctxpipe.ui.source": "query",
      "ctxpipe.ui.key": "public-invitation-details",
    })
  })
})

describe("expected states", () => {
  it("records a 409 not-ready answer as an action, not an Error span", async () => {
    const client = createHyperDxQueryClient()
    const error = Object.assign(
      new Error("Conversation sandbox is not ready"),
      {
        status: 409,
      },
    )
    await expect(
      client.fetchQuery({
        queryKey: ["conversation-git-status", "acme", "conv_1"],
        retry: false,
        queryFn: () => {
          throw error
        },
      }),
    ).rejects.toThrow(error)

    expect(recordException).not.toHaveBeenCalled()
    expect(addAction).toHaveBeenCalledWith("ui_expected_state", {
      "ctxpipe.ui.source": "query",
      "ctxpipe.ui.key": "conversation-git-status",
      "ctxpipe.ui.http_status": "409",
    })
  })

  it("records a 404 on the turn changes of a new conversation as an action", async () => {
    const client = createHyperDxQueryClient()
    const error = Object.assign(new Error("Not found"), { status: 404 })
    await expect(
      client.fetchQuery({
        queryKey: ["conversation-turn-changes", "acme", "conv_new"],
        retry: false,
        queryFn: () => {
          throw error
        },
      }),
    ).rejects.toThrow(error)

    expect(recordException).not.toHaveBeenCalled()
    expect(addAction).toHaveBeenCalledTimes(1)
  })

  it("still records a 404 on another query and a 500 on turn changes", async () => {
    const client = createHyperDxQueryClient()
    const notFound = Object.assign(new Error("Not found"), { status: 404 })
    const failed = Object.assign(new Error("boom"), { status: 500 })
    await expect(
      client.fetchQuery({
        queryKey: ["conversation-git-blob"],
        retry: false,
        queryFn: () => {
          throw notFound
        },
      }),
    ).rejects.toThrow(notFound)
    await expect(
      client.fetchQuery({
        queryKey: ["conversation-turn-changes"],
        retry: false,
        queryFn: () => {
          throw failed
        },
      }),
    ).rejects.toThrow(failed)

    expect(recordException).toHaveBeenCalledTimes(2)
    expect(addAction).not.toHaveBeenCalled()
  })
})

describe("recordHyperDxScreenError", () => {
  it("records a screen error with its screen, route template and path", () => {
    recordHyperDxScreenError("org_access_denied", {
      route: "/$orgSlug",
      path: "/no-such-org",
    })
    const [error, attributes] = recordException.mock.calls[0] ?? []
    expect((error as Error).message).toBe("UI screen: org_access_denied")
    expect(attributes).toEqual({
      "ctxpipe.ui.source": "screen",
      "ctxpipe.ui.screen": "org_access_denied",
      route: "/$orgSlug",
      "url.path": "/no-such-org",
    })
  })
})
