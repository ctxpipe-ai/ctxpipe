import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { StreamChunk } from "@tanstack/ai"
import { initLogger } from "evlog"
import {
  bunSocketToWebSocketLike,
  type ConversationWebSocketData,
  conversationWebSocketHandlers,
} from "../routes/v1/conversation-websocket.js"
import { withNativeChatFixture } from "./native-chat-fixture.js"

initLogger({ enabled: false })
type Frame = { id: string; chunk: StreamChunk }
const activeDisconnect = process.argv.includes("--active-disconnect")

await withNativeChatFixture(async (f) => {
  // Auth/session rows are fixture data. The production socket handlers,
  // native durability, runtime resolution, Git, PG and OpenCode run for real.
  const server = Bun.serve<ConversationWebSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, host) {
      const upgraded = host.upgrade(request, {
        data: {
          kind: "workspace-chat",
          orgSlug: f.orgSlug,
          orgId: f.orgId,
          conversationId: f.conversationId,
          userId: f.userId,
          request,
          socket: bunSocketToWebSocketLike({ send() {}, close() {} }),
        },
      })
      return upgraded
        ? undefined
        : new Response("Upgrade failed", { status: 500 })
    },
    websocket: conversationWebSocketHandlers,
  })
  const url = `ws://127.0.0.1:${server.port}/${f.orgSlug}/api/v1/conversations/${f.conversationId}`
  const runId = `run-${f.conversationId}`
  const sockets: WebSocket[] = []
  async function collect(
    address: string,
    run?: object,
    disconnectEarly = false,
  ): Promise<Frame[]> {
    const socket = new WebSocket(address)
    sockets.push(socket)
    return new Promise((resolve, reject) => {
      const frames: Frame[] = []
      let settled = false
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error("Native WebSocket turn timed out"))
      }, 45_000)
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("Native WebSocket failed"))
      })
      socket.addEventListener("open", () => {
        if (run) socket.send(JSON.stringify(run))
      })
      socket.addEventListener("message", (event) => {
        if (settled) return
        const frame = JSON.parse(String(event.data)) as Frame
        if (!frame.chunk) return
        frames.push(frame)
        if (disconnectEarly && frame.chunk.type === "RUN_STARTED") {
          settled = true
          clearTimeout(timer)
          socket.close()
          resolve(frames)
        } else if (frame.chunk.type === "RUN_ERROR") {
          clearTimeout(timer)
          socket.close()
          if (activeDisconnect && frame.chunk.code === "aborted")
            resolve(frames)
          else reject(new Error(JSON.stringify(frame.chunk)))
        } else if (frame.chunk.type === "RUN_FINISHED") {
          clearTimeout(timer)
          socket.close()
          resolve(frames)
        }
      })
    })
  }
  try {
    const prefix = await collect(
      url,
      {
        threadId: f.conversationId,
        runId,
        messages: [
          { id: "user-socket", role: "user", content: "First socket question" },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { workspaceId: f.workspaceId },
      },
      activeDisconnect,
    )
    const first = activeDisconnect
      ? [
          ...prefix,
          ...(await collect(
            `${url}?runId=${encodeURIComponent(runId)}&offset=${encodeURIComponent(prefix.at(-1)?.id ?? "")}`,
          )),
        ]
      : prefix
    const modelCalls = f.modelRequests.length
    const resumed = await collect(
      `${url}?runId=${encodeURIComponent(runId)}&offset=${encodeURIComponent(first[0]?.id ?? "")}`,
    )
    const noReplayModelCall = f.modelRequests.length === modelCalls
    if (activeDisconnect) {
      await collect(url, {
        threadId: f.conversationId,
        runId: `${runId}-retry`,
        messages: [
          { id: "user-socket", role: "user", content: "First socket question" },
          {
            id: "user-retry",
            role: "user",
            content: "Question after disconnect",
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { workspaceId: f.workspaceId },
      })
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("./native-chat-reconstruct-client.ts", import.meta.url),
        ),
        f.orgId,
        f.conversationId,
      ],
      { timeout: 15_000 },
    )
    const reloaded = JSON.parse(stdout.trim()) as {
      messages: Array<{ parts: Array<{ type: string; content?: string }> }>
    }
    process.stdout.write(
      `${JSON.stringify({
        ...(activeDisconnect
          ? {
              abortedTerminal: first.some(
                (frame) =>
                  frame.chunk.type === "RUN_ERROR" &&
                  frame.chunk.code === "aborted",
              ),
              retryMadeOneModelCall: f.modelRequests.length === modelCalls + 1,
              disconnectedBeforeTerminal: prefix.every(
                (frame) => frame.chunk.type !== "RUN_FINISHED",
              ),
            }
          : {}),
        replayMatches:
          JSON.stringify(resumed) === JSON.stringify(first.slice(1)),
        oneTerminal:
          first.filter(
            (frame) =>
              frame.chunk.type === "RUN_FINISHED" ||
              frame.chunk.type === "RUN_ERROR",
          ).length === 1,
        noReplayModelCall,
        freshTranscript: reloaded.messages.map((message) =>
          message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.content ?? "")
            .join(""),
        ),
      })}\n`,
    )
  } finally {
    for (const socket of sockets) socket.close()
    await server.stop(true)
  }
})
