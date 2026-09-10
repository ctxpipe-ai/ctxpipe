import { afterEach, describe, expect, it, vi } from "vitest"
import {
  shouldReuseWarmedWorkspaceChatSocket,
  workspaceChatSocketIsResume,
  workspaceChatSocketPath,
  workspaceChatWebSocket,
} from "./workspaceChatWebSocket"

describe("workspaceChatSocketPath", () => {
  it("builds the org-scoped conversation websocket path", () => {
    expect(workspaceChatSocketPath("acme", "conv_1")).toBe(
      "/acme/api/v1/conversations/conv_1",
    )
  })
})

describe("workspaceChatWebSocket hydrate", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("loads reconstructChat JSON from GET …/chat", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        messages: [{ id: "m1", role: "user" }],
        activeRun: { runId: "run_1" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const connection = workspaceChatWebSocket("acme", "conv_1")
    await expect(connection.hydrate("conv_1")).resolves.toEqual({
      messages: [{ id: "m1", role: "user" }],
      activeRun: { runId: "run_1" },
      interrupts: null,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/conversations/conv_1/chat?threadId=conv_1",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  it.each([
    401, 403, 500,
  ])("throws when hydration returns %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    )

    const connection = workspaceChatWebSocket("acme", "conv_1")

    await expect(connection.hydrate("conv_1")).rejects.toMatchObject({
      status,
    })
  })

  it("treats a missing thread as an empty hydration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    )

    const connection = workspaceChatWebSocket("acme", "conv_1")

    await expect(connection.hydrate("conv_1")).resolves.toEqual({
      messages: [],
      activeRun: null,
      interrupts: null,
    })
  })

  it("surfaces malformed hydration JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const connection = workspaceChatWebSocket("acme", "conv_1")

    await expect(connection.hydrate("conv_1")).rejects.toThrow()
  })

  it("accepts a valid empty hydration response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ messages: [], activeRun: null })),
    )

    const connection = workspaceChatWebSocket("acme", "conv_1")

    await expect(connection.hydrate("conv_1")).resolves.toEqual({
      messages: [],
      activeRun: null,
      interrupts: null,
    })
  })
})

describe("workspace chat websocket dispose", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("closes the warmed socket", () => {
    const instances: Array<{ close: ReturnType<typeof vi.fn> }> = []
    class FakeSocket {
      readyState = 1
      url: string
      close = vi.fn(() => {
        this.readyState = 3
      })
      constructor(url: string | URL) {
        this.url = String(url)
        instances.push(this)
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    const connection = workspaceChatWebSocket("acme", "conv_1")
    connection.warm()
    expect(instances).toHaveLength(1)
    connection.dispose()
    expect(instances[0]?.close).toHaveBeenCalledTimes(1)
    connection.dispose()
    expect(instances[0]?.close).toHaveBeenCalledTimes(1)
  })

  it("closes every socket it created, not only the last warm", () => {
    const instances: Array<{ close: ReturnType<typeof vi.fn> }> = []
    class FakeSocket {
      readyState = 1
      url: string
      close = vi.fn(() => {
        this.readyState = 3
      })
      constructor(url: string | URL) {
        this.url = String(url)
        instances.push(this)
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    const connection = workspaceChatWebSocket("acme", "conv_1")
    connection.warm()
    const first = instances[0]
    if (first) first.readyState = 3
    connection.warm()
    expect(instances).toHaveLength(2)
    connection.dispose()
    expect(instances[0]?.close).toHaveBeenCalledTimes(1)
    expect(instances[1]?.close).toHaveBeenCalledTimes(1)
  })

  it("closes a socket that already failed the handshake", () => {
    const instances: Array<{ close: ReturnType<typeof vi.fn> }> = []
    class FakeSocket {
      readyState = 3
      url: string
      close = vi.fn()
      constructor(url: string | URL) {
        this.url = String(url)
        instances.push(this)
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    const connection = workspaceChatWebSocket("acme", "conv_1")
    connection.warm()
    connection.dispose()
    expect(instances[0]?.close).toHaveBeenCalledTimes(1)
  })
})

describe("workspace chat websocket reuse", () => {
  it("does not reuse a warmed socket for a resume handshake", () => {
    const warmed =
      "wss://app.ctxpipe.localhost/acme/api/v1/conversations/conv_1"
    const resume =
      "wss://app.ctxpipe.localhost/acme/api/v1/conversations/conv_1?runId=run_1&offset=3"
    expect(workspaceChatSocketIsResume(resume)).toBe(true)
    expect(shouldReuseWarmedWorkspaceChatSocket(warmed, resume)).toBe(false)
    expect(shouldReuseWarmedWorkspaceChatSocket(warmed, warmed)).toBe(true)
  })
})
