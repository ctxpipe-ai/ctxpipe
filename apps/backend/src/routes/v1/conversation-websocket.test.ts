import { randomUUID } from "node:crypto"

import { EventType, memoryStream, type StreamChunk } from "@tanstack/ai"
import { describe, expect, it, vi } from "vitest"

import {
  bunSocketToWebSocketLike,
  conversationWebSocketHasResumeOffset,
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
  startConversationChatSocket,
} from "./conversation-websocket-stream.js"

describe("workspace chat official websocket hosting", () => {
  it("matches the conversation upgrade path and ignores Vite HMR", () => {
    expect(
      parseConversationWebSocketUpgradeUrl(
        "http://localhost:3000/acme/api/v1/conversations/conv_1",
      ),
    ).toEqual({ orgSlug: "acme", conversationId: "conv_1" })
    expect(
      isWorkspaceChatWebSocketRequest(
        new Request("http://localhost:3000/@vite/client", {
          headers: { upgrade: "websocket" },
        }),
      ),
    ).toBe(false)
    expect(
      isWorkspaceChatWebSocketRequest(
        new Request("http://localhost:3000/acme/api/v1/conversations/conv_1", {
          headers: { upgrade: "websocket" },
        }),
      ),
    ).toBe(true)
  })

  it("adapts a Bun-style socket to WebSocketLike", () => {
    const sent: string[] = []
    const like = bunSocketToWebSocketLike({
      send: (data) => {
        sent.push(data)
      },
      close: vi.fn(),
    })
    const messages: unknown[] = []
    like.addEventListener("message", (ev) => {
      messages.push(ev.data)
    })
    like.send("ping")
    like.dispatchMessage("hello")
    expect(sent).toEqual(["ping"])
    expect(messages).toEqual(["hello"])
  })
})

describe("workspace chat websocket resume", () => {
  it("treats a handshake offset as a durability replay", () => {
    expect(
      conversationWebSocketHasResumeOffset(
        "http://localhost:3000/acme/api/v1/conversations/conv_1?runId=run_1&offset=-1",
      ),
    ).toBe(true)
    expect(
      conversationWebSocketHasResumeOffset(
        "http://localhost:3000/acme/api/v1/conversations/conv_1",
      ),
    ).toBe(false)
  })

  it("replays the durability log instead of starting onRun", async () => {
    await memoryStream({ runId: "org_1/user_1/conv_1/run_1" }).append([
      {
        type: EventType.RUN_STARTED,
        threadId: "conv_1",
        runId: "run_1",
        timestamp: 0,
      },
    ])
    const resume = vi.fn()
    const stream = vi.fn()
    const onRun = vi.fn()
    const socket = bunSocketToWebSocketLike({
      send: vi.fn(),
      close: vi.fn(),
    })
    expect(
      startConversationChatSocket(
        socket,
        new Request(
          "http://localhost:3000/acme/api/v1/conversations/conv_1?runId=run_1&offset=-1",
        ),
        { orgId: "org_1", userId: "user_1", conversationId: "conv_1" },
        onRun,
        { transport: { resume, stream } },
      ),
    ).toBe("resume")
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
    expect(stream).not.toHaveBeenCalled()
    expect(onRun).not.toHaveBeenCalled()
  })

  it("starts a fresh turn when the handshake has no offset", () => {
    const resume = vi.fn()
    const stream = vi.fn()
    const onRun = vi.fn()
    const socket = bunSocketToWebSocketLike({
      send: vi.fn(),
      close: vi.fn(),
    })
    expect(
      startConversationChatSocket(
        socket,
        new Request("http://localhost:3000/acme/api/v1/conversations/conv_1"),
        { orgId: "org_1", userId: "user_1", conversationId: "conv_1" },
        onRun,
        { transport: { resume, stream } },
      ),
    ).toBe("run")
    expect(stream).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })
})

describe("workspace chat turn lifetime", () => {
  const scope = { orgId: "org_1", userId: "user_1", conversationId: "conv_1" }

  /** A turn that waits for the answer, as a model call does. */
  function scriptedTurn() {
    let answer!: () => void
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    const signals: AbortSignal[] = []
    const onRun = async function* (ctx: {
      threadId: string
      runId: string
      signal: AbortSignal
    }) {
      signals.push(ctx.signal)
      const run = { threadId: ctx.threadId, runId: ctx.runId, timestamp: 0 }
      yield { type: EventType.RUN_STARTED, ...run } as StreamChunk
      const stopped = new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      await Promise.race([answered, stopped])
      if (ctx.signal.aborted) return
      yield { type: EventType.RUN_FINISHED, ...run } as StreamChunk
    }
    return { onRun, answer, signals }
  }

  function openSocket(
    onRun: Parameters<typeof startConversationChatSocket>[3],
    query = "",
    socketScope = scope,
    options: Parameters<typeof startConversationChatSocket>[4] = {},
  ) {
    const frames: Array<{ chunk?: StreamChunk }> = []
    const close = vi.fn()
    const socket = bunSocketToWebSocketLike({
      send: (data) => {
        frames.push(JSON.parse(data))
      },
      close,
    })
    startConversationChatSocket(
      socket,
      new Request(
        `http://localhost:3000/acme/api/v1/conversations/conv_1${query}`,
      ),
      socketScope,
      onRun,
      options,
    )
    const types = () => frames.map((frame) => frame.chunk?.type)
    return { socket, types, close }
  }

  function startTurn(
    onRun: Parameters<typeof startConversationChatSocket>[3],
    runId: string,
    options: Parameters<typeof startConversationChatSocket>[4] = {},
  ) {
    const opened = openSocket(onRun, "", scope, options)
    opened.socket.dispatchMessage(
      JSON.stringify({
        threadId: "conv_1",
        runId,
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    )
    return opened
  }

  it("keeps a turn running when the browser closes its socket", async () => {
    const runId = `run_${randomUUID()}`
    const turn = scriptedTurn()
    const first = startTurn(turn.onRun, runId)
    await vi.waitFor(() => expect(first.types()).toContain("RUN_STARTED"))

    first.socket.dispatchClose()
    turn.answer()

    // The turn ends in its run log, and a later socket attaches to the end.
    const log = memoryStream({ runId: `org_1/user_1/conv_1/${runId}` })
    await vi.waitFor(async () =>
      expect((await log.snapshot()).map((entry) => entry.chunk.type)).toContain(
        "RUN_FINISHED",
      ),
    )
    expect(turn.signals[0]?.aborted).toBe(false)
    expect(first.types()).not.toContain("RUN_FINISHED")
    const attached = openSocket(turn.onRun, `?runId=${runId}&offset=-1`)
    await vi.waitFor(() =>
      expect(attached.types()).toEqual(
        expect.arrayContaining(["RUN_STARTED", "RUN_FINISHED"]),
      ),
    )
  })

  it("stops a turn from the socket that started it", async () => {
    const runId = `run_${randomUUID()}`
    const turn = scriptedTurn()
    const first = startTurn(turn.onRun, runId)
    await vi.waitFor(() => expect(first.types()).toContain("RUN_STARTED"))

    first.socket.dispatchMessage(JSON.stringify({ type: "abort", runId }))

    expect(turn.signals[0]?.aborted).toBe(true)
  })

  it("stops a turn whose socket closed from a later socket of the same user", async () => {
    const runId = `run_${randomUUID()}`
    const turn = scriptedTurn()
    const first = startTurn(turn.onRun, runId)
    await vi.waitFor(() => expect(first.types()).toContain("RUN_STARTED"))
    first.socket.dispatchClose()
    const stop = JSON.stringify({ type: "abort", runId })

    // Another user of the organization cannot stop the turn.
    openSocket(turn.onRun, `?runId=${runId}&offset=-1`, {
      ...scope,
      userId: "user_2",
    }).socket.dispatchMessage(stop)
    expect(turn.signals[0]?.aborted).toBe(false)

    openSocket(turn.onRun, `?runId=${runId}&offset=-1`).socket.dispatchMessage(
      stop,
    )
    expect(turn.signals[0]?.aborted).toBe(true)
  })

  it("stops a turn at its time limit", async () => {
    const runId = `run_${randomUUID()}`
    const turn = scriptedTurn()
    const first = startTurn(turn.onRun, runId, { maxTurnMs: 20 })
    await vi.waitFor(() => expect(first.types()).toContain("RUN_STARTED"))
    first.socket.dispatchClose()

    await vi.waitFor(() => expect(turn.signals[0]?.aborted).toBe(true))
  })

  it("ends a run that no turn in this process runs when a socket joins it", async () => {
    const runId = `run_${randomUUID()}`
    const endLostRun = vi.fn(async () => {})
    const join = openSocket(
      scriptedTurn().onRun,
      `?runId=${runId}&offset=-1`,
      scope,
      { endLostRun },
    )

    await vi.waitFor(() =>
      expect(join.close).toHaveBeenCalledWith(1011, "resume failed"),
    )
    expect(endLostRun).toHaveBeenCalledWith(runId)
  })

  it("does not end a run that another user's turn runs", async () => {
    const runId = `run_${randomUUID()}`
    const turn = scriptedTurn()
    const first = startTurn(turn.onRun, runId)
    await vi.waitFor(() => expect(first.types()).toContain("RUN_STARTED"))
    const endLostRun = vi.fn(async () => {})

    // The run log of the other user has no entries, but the turn runs.
    const join = openSocket(
      turn.onRun,
      `?runId=${runId}&offset=-1`,
      { ...scope, userId: "user_2" },
      { endLostRun },
    )

    await vi.waitFor(() =>
      expect(join.close).toHaveBeenCalledWith(1011, "resume failed"),
    )
    expect(endLostRun).not.toHaveBeenCalled()
    turn.answer()
  })
})
