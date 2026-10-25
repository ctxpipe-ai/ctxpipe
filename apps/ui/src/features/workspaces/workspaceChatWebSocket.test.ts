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
      "/acme/api/v1/conversations/conv_1/chat?",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  it("revives ISO-string createdAt on hydrated messages", async () => {
    const createdAt = "2026-09-13T09:00:00.000Z"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          messages: [{ id: "m1", role: "user", createdAt }],
          activeRun: null,
        }),
      ),
    )
    const connection = workspaceChatWebSocket("acme", "conv_1")
    const hydrated = await connection.hydrate("conv_1")
    expect(hydrated.messages[0]?.createdAt).toEqual(new Date(createdAt))
    expect(hydrated.messages[0]?.createdAt).toBeInstanceOf(Date)
  })

  it.each([401, 403, 500])(
    "throws when hydration returns %i",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      )

      const connection = workspaceChatWebSocket("acme", "conv_1")

      await expect(connection.hydrate("conv_1")).rejects.toMatchObject({
        status,
      })
    },
  )

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
    const instances: Array<{
      close: ReturnType<typeof vi.fn>
      readyState: number
    }> = []
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

describe("workspace chat websocket stop", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  class FakeSocket {
    static instances: FakeSocket[] = []
    readyState = 0
    url: string
    sent: string[] = []
    listeners = new Map<string, () => void>()
    send = vi.fn((data: string) => {
      this.sent.push(data)
    })
    close = vi.fn(() => {
      this.readyState = 3
    })
    constructor(url: string | URL) {
      this.url = String(url)
      FakeSocket.instances.push(this)
    }
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener)
    }
    open() {
      this.readyState = 1
      this.listeners.get("open")?.()
    }
  }

  it("sends the abort frame of the run on a socket that is open", () => {
    FakeSocket.instances = []
    vi.stubGlobal("WebSocket", FakeSocket)
    const connection = workspaceChatWebSocket("acme", "conv_1")
    connection.warm()
    FakeSocket.instances[0]?.open()

    connection.stopRun("run_1")

    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0]?.sent).toEqual([
      JSON.stringify({ type: "abort", runId: "run_1" }),
    ])
  })

  it("opens a socket for the abort frame when no socket is open", () => {
    FakeSocket.instances = []
    vi.stubGlobal("WebSocket", FakeSocket)
    const connection = workspaceChatWebSocket("acme", "conv_1")

    connection.stopRun("run_1")
    const socket = FakeSocket.instances[0]
    expect(socket?.url).toMatch(/\/acme\/api\/v1\/conversations\/conv_1$/)
    socket?.open()

    expect(socket?.sent).toEqual([
      JSON.stringify({ type: "abort", runId: "run_1" }),
    ])
    expect(socket?.close).toHaveBeenCalledTimes(1)
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

  it("sends the first run frame on the warmed socket, with no second handshake", async () => {
    const instances: Array<{ url: string; sent: string[] }> = []
    class FakeSocket {
      readyState = 1
      url: string
      sent: string[] = []
      onopen: (() => void) | null = null
      close = vi.fn()
      send(data: string) {
        this.sent.push(data)
      }
      constructor(url: string | URL) {
        this.url = String(url)
        instances.push(this)
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    try {
      const connection = workspaceChatWebSocket("acme", "conv_1")
      connection.warm()
      // The chat client opens the run at `?runId=`, as on the first Send.
      await connection.send([], {}, undefined, {
        runId: "run_1",
        threadId: "conv_1",
      })
      expect(instances).toHaveLength(1)
      expect(instances[0]?.sent).toHaveLength(1)
      expect(JSON.parse(instances[0]?.sent[0] ?? "{}")).toMatchObject({
        runId: "run_1",
      })
      connection.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("never hands a resume socket to a later run, even when it is still open", async () => {
    vi.useFakeTimers()
    const instances: FakeSocket[] = []
    class FakeSocket {
      readyState = 1
      url: string
      sent: string[] = []
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      close = vi.fn(() => {
        this.readyState = 3
      })
      send(data: string) {
        this.sent.push(data)
      }
      constructor(url: string | URL) {
        this.url = String(url)
        instances.push(this)
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    try {
      const connection = workspaceChatWebSocket("acme", "conv_1")
      connection.warm()
      const first = new AbortController()
      await connection.send([], {}, first.signal, {
        runId: "run_1",
        threadId: "conv_1",
      })
      expect(instances).toHaveLength(1)
      // The server tags an event with an offset, then the socket drops.
      instances[0]?.onmessage?.({
        data: JSON.stringify({
          id: "1",
          chunk: { type: "RUN_STARTED", runId: "run_1", threadId: "conv_1" },
        }),
      })
      if (instances[0]) instances[0].readyState = 3
      instances[0]?.onclose?.()
      await vi.advanceTimersByTimeAsync(250)
      const resume = instances[1]
      expect(resume?.url).toContain("offset=1")
      // Stop keeps the resume socket open. A new message opens run_2.
      first.abort()
      const sending = connection.send([], {}, undefined, {
        runId: "run_2",
        threadId: "conv_1",
      })
      await vi.advanceTimersByTimeAsync(0)
      const run2 = instances[2]
      expect(instances).toHaveLength(3)
      expect(run2?.url).toContain("runId=run_2")
      expect(run2?.url).not.toContain("offset")
      await sending
      expect(run2?.sent).toHaveLength(1)
      expect(JSON.parse(run2?.sent[0] ?? "{}")).toMatchObject({
        runId: "run_2",
      })
      connection.dispose()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
