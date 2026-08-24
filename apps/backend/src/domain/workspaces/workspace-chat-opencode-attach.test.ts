import { afterEach, describe, expect, it, vi } from "vitest"
import type { TanstackLikeHandle } from "./job-sandbox.js"

const startOpencodeServerInSandbox = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/ai-opencode", () => ({
  startOpencodeServerInSandbox: (...args: unknown[]) =>
    startOpencodeServerInSandbox(...args),
  startOpencodeSession: vi.fn(),
  translateOpencodeStream: vi.fn(),
}))

import {
  adoptConversationOpenCodeServe,
  startConversationOpenCodeServe,
} from "./workspace-chat-opencode-attach.js"

const originalFetch = globalThis.fetch

function handle(input?: {
  spawn?: () => Promise<{
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    kill: () => Promise<void>
  }>
  exec?: TanstackLikeHandle["process"]["exec"]
}): TanstackLikeHandle {
  return {
    process: {
      exec:
        input?.exec ??
        (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      ...(input?.spawn ? { spawn: input.spawn } : {}),
    },
    ports: {
      connect: async (port: number) => ({
        url: `http://127.0.0.1:${port}`,
      }),
    },
    fs: {
      write: async () => undefined,
      read: async () => "",
      remove: async () => undefined,
      mkdir: async () => undefined,
    },
    destroy: async () => {},
  } as TanstackLikeHandle
}

function mockFetch(status: number): void {
  globalThis.fetch = (async () =>
    new Response(status === 200 ? "ok" : "no", {
      status,
    })) as unknown as typeof fetch
}

describe("startConversationOpenCodeServe", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    startOpencodeServerInSandbox.mockReset()
  })

  it("reuses a healthy serve without spawning", async () => {
    mockFetch(200)
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
    mockFetch(503)
    startOpencodeServerInSandbox.mockRejectedValue(new Error("ServeError"))
    const exec = vi.fn(
      async (
        _command?: string,
        _options?: { cwd?: string; env?: Record<string, string> },
      ) => ({
        stdout: "99\n",
        stderr: "",
        exitCode: 0,
      }),
    )
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
    mockFetch(503)
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

  it("adopts a healthy listener for later turns", async () => {
    mockFetch(200)
    const adopted = await adoptConversationOpenCodeServe(4097)
    expect(adopted?.baseUrl).toBe("http://127.0.0.1:4097")
  })
})
