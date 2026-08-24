import { afterEach, describe, expect, it, vi } from "vitest"

const startOpencodeServerInSandbox = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/ai-opencode", () => ({
  startOpencodeServerInSandbox: (...args: unknown[]) =>
    startOpencodeServerInSandbox(...args),
  startOpencodeSession: vi.fn(),
  translateOpencodeStream: vi.fn(),
}))

import { startConversationOpenCodeServe } from "./workspace-chat-opencode-attach.js"

const originalFetch = globalThis.fetch

function handle(input?: {
  spawn?: () => Promise<{
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    kill: () => Promise<void>
  }>
  exec?: () => Promise<{ stdout: string; stderr: string; exitCode: number }>
}) {
  return {
    process: {
      exec:
        input?.exec ??
        vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      ...(input?.spawn ? { spawn: input.spawn } : {}),
    },
    ports: {
      connect: vi.fn(async (port: number) => ({
        url: `http://127.0.0.1:${port}`,
      })),
    },
    fs: {},
    destroy: vi.fn(async () => {}),
  }
}

describe("startConversationOpenCodeServe", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    startOpencodeServerInSandbox.mockReset()
  })

  it("reuses a healthy serve without spawning", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 }))
    const spawn = vi.fn()
    const started = await startConversationOpenCodeServe({
      handle: handle({ spawn }),
      port: 4097,
      isolation: "local_process",
    })
    expect(started?.baseUrl).toBe("http://127.0.0.1:4097")
    expect(spawn).not.toHaveBeenCalled()
    expect(startOpencodeServerInSandbox).not.toHaveBeenCalled()
  })

  it("does not exec-fallback after an official spawn failure", async () => {
    globalThis.fetch = vi.fn(async () => new Response("no", { status: 503 }))
    startOpencodeServerInSandbox.mockRejectedValue(new Error("ServeError"))
    const exec = vi.fn(async () => ({
      stdout: "99\n",
      stderr: "",
      exitCode: 0,
    }))
    const started = await startConversationOpenCodeServe({
      handle: handle({
        spawn: vi.fn(),
        exec,
      }),
      port: 4097,
      isolation: "local_process",
    })
    expect(started).toBeNull()
    expect(startOpencodeServerInSandbox).toHaveBeenCalled()
    expect(
      exec.mock.calls.some(([command]) => String(command).includes("nohup")),
    ).toBe(false)
  })

  it("returns the official serve when spawn succeeds", async () => {
    globalThis.fetch = vi.fn(async () => new Response("no", { status: 503 }))
    startOpencodeServerInSandbox.mockResolvedValue({
      baseUrl: "http://127.0.0.1:4097",
      headers: { Authorization: "Bearer tok" },
      dispose: vi.fn(async () => {}),
    })
    const started = await startConversationOpenCodeServe({
      handle: handle({ spawn: vi.fn() }),
      port: 4097,
      isolation: "local_process",
    })
    expect(started).toEqual(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:4097",
        headers: { Authorization: "Bearer tok" },
      }),
    )
  })
})
