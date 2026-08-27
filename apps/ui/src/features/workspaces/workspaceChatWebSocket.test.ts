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
