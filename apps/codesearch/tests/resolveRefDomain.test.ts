import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveRepositoryRef } from "../src/domain/repositories/resolveRef.js"

function streamFromString(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content))
      controller.close()
    },
  })
}

describe("resolveRepositoryRef", () => {
  const spawnMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("Bun", {
      spawn: spawnMock,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("resolves a provided branch to hash", async () => {
    spawnMock.mockReturnValue({
      stdout: streamFromString("abc123\trefs/heads/main\n"),
      stderr: streamFromString(""),
      exited: Promise.resolve(0),
    })

    const resolved = await resolveRepositoryRef({
      gitUrl: "https://github.com/appear/ctxpipe.git",
      branch: "main",
      githubToken: "token",
    })

    expect(resolved).toEqual({ branch: "main", hash: "abc123" })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const command = spawnMock.mock.calls[0]?.[0] as string[]
    expect(command).toContain("ls-remote")
    expect(command).toContain("refs/heads/main")
  })

  it("resolves default branch then branch hash when branch is omitted", async () => {
    spawnMock
      .mockReturnValueOnce({
        stdout: streamFromString("ref: refs/heads/main\tHEAD\n"),
        stderr: streamFromString(""),
        exited: Promise.resolve(0),
      })
      .mockReturnValueOnce({
        stdout: streamFromString("def456\trefs/heads/main\n"),
        stderr: streamFromString(""),
        exited: Promise.resolve(0),
      })

    const resolved = await resolveRepositoryRef({
      gitUrl: "https://github.com/appear/ctxpipe.git",
    })

    expect(resolved).toEqual({ branch: "main", hash: "def456" })
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const first = spawnMock.mock.calls[0]?.[0] as string[]
    const second = spawnMock.mock.calls[1]?.[0] as string[]
    expect(first).toContain("--symref")
    expect(second).toContain("refs/heads/main")
  })

  it("throws when git command fails", async () => {
    spawnMock.mockReturnValue({
      stdout: streamFromString(""),
      stderr: streamFromString("fatal: inaccessible"),
      exited: Promise.resolve(128),
    })

    await expect(
      resolveRepositoryRef({
        gitUrl: "https://github.com/appear/ctxpipe.git",
        branch: "main",
      }),
    ).rejects.toThrow("Command failed with exit code 128")
  })
})
