import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScipIndexerId } from "./detectLanguages.js"
import {
  runScipIndexer,
  SCIP_INDEXER_ARGV,
  SCIP_INDEXER_OUTPUT_FLAG,
} from "./scipIndexers.js"

function fakeSubprocess(exited: Promise<number>): ReturnType<typeof Bun.spawn> {
  return {
    exited,
    stdout: null,
    stderr: null,
  } as unknown as ReturnType<typeof Bun.spawn>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SCIP_INDEXER_ARGV", () => {
  it.each<[ScipIndexerId, readonly string[]]>([
    ["go", ["scip-go"]],
    ["typescript", ["scip-typescript", "index"]],
    ["python", ["scip-python", "index", "."]],
    ["java", ["scip-java", "index"]],
    ["rust", ["rust-analyzer", "scip", "."]],
    ["clang", ["scip-clang", "--compdb-path=compile_commands.json"]],
    ["ruby", ["scip-ruby"]],
    ["dotnet", ["scip-dotnet", "index"]],
    ["dart", ["scip_dart"]],
    ["php", ["scip-php"]],
    ["debian", ["debian-lsp", "scip", "."]],
  ])("maps %s to its official CLI", (indexerId, expectedArgv) => {
    expect(SCIP_INDEXER_ARGV[indexerId]).toEqual(expectedArgv)
  })

  it("contains exactly every detected indexer family", () => {
    expect(Object.keys(SCIP_INDEXER_ARGV)).toEqual([
      "go",
      "typescript",
      "python",
      "java",
      "rust",
      "clang",
      "ruby",
      "dotnet",
      "dart",
      "php",
      "debian",
    ])
  })

  it("uses each indexer's supported direct-output flag", () => {
    expect(SCIP_INDEXER_OUTPUT_FLAG).toEqual({
      go: "--output",
      typescript: "--output",
      python: "--output",
      java: "--output",
      rust: "--output",
      clang: "--index-output-path",
      ruby: "--index-file",
      dotnet: "--output",
      dart: "--output",
      php: null,
      debian: "-o",
    })
  })
})

describe("runScipIndexer", () => {
  it("runs direct-output indexers concurrently against unique shards", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const goShard = join(directory, "shards", "go.scip")
    const typescriptShard = join(directory, "shards", "typescript.scip")
    await mkdir(checkoutPath)

    const exits: Array<() => void> = []
    const spawn = vi.fn((argv: string[]) => {
      writeFileSync(argv.at(-1) as string, `index-${exits.length}`)
      let resolveExit: () => void = () => undefined
      const exited = new Promise<number>((resolve) => {
        resolveExit = () => resolve(0)
      })
      exits.push(resolveExit)
      return fakeSubprocess(exited)
    })
    vi.stubGlobal("Bun", { spawn })

    try {
      const runs = [
        runScipIndexer({
          indexerId: "go",
          checkoutPath,
          shardPath: goShard,
        }),
        runScipIndexer({
          indexerId: "typescript",
          checkoutPath,
          shardPath: typescriptShard,
        }),
      ]

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      expect(spawn.mock.calls[0]?.[0]).toEqual([
        "scip-go",
        "--output",
        resolve(goShard),
      ])
      expect(spawn.mock.calls[1]?.[0]).toEqual([
        "scip-typescript",
        "index",
        "--output",
        resolve(typescriptShard),
      ])
      expect(existsSync(join(checkoutPath, "index.scip"))).toBe(false)

      for (const resolveExit of exits) resolveExit()
      await Promise.all(runs)
      expect(readFileSync(goShard, "utf8")).toBe("index-0")
      expect(readFileSync(typescriptShard, "utf8")).toBe("index-1")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("serializes default-output indexers per checkout and publishes after exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const generatedPath = join(checkoutPath, "index.scip")
    const firstShard = join(directory, "shards", "php-1.scip")
    const secondShard = join(directory, "shards", "php-2.scip")
    await mkdir(checkoutPath)
    writeFileSync(generatedPath, "stale")

    const exits: Array<() => void> = []
    const spawn = vi.fn((argv: string[]) => {
      expect(argv).toEqual(["scip-php"])
      expect(existsSync(generatedPath)).toBe(false)
      writeFileSync(generatedPath, `index-${exits.length}`)
      let resolveExit: () => void = () => undefined
      const exited = new Promise<number>((resolve) => {
        resolveExit = () => resolve(0)
      })
      exits.push(resolveExit)
      return fakeSubprocess(exited)
    })
    vi.stubGlobal("Bun", { spawn })

    try {
      const first = runScipIndexer({
        indexerId: "php",
        checkoutPath,
        shardPath: firstShard,
      })
      const second = runScipIndexer({
        indexerId: "php",
        checkoutPath,
        shardPath: secondShard,
      })

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
      expect(existsSync(firstShard)).toBe(false)
      exits[0]?.()
      await first

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      expect(existsSync(secondShard)).toBe(false)
      exits[1]?.()
      await second

      expect(readFileSync(firstShard, "utf8")).toBe("index-0")
      expect(readFileSync(secondShard, "utf8")).toBe("index-1")
      expect(existsSync(generatedPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects and removes an empty final shard", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "go.scip")
    await mkdir(checkoutPath)

    vi.stubGlobal("Bun", {
      spawn: vi.fn((argv: string[]) => {
        writeFileSync(argv.at(-1) as string, "")
        return fakeSubprocess(Promise.resolve(0))
      }),
    })

    try {
      await expect(
        runScipIndexer({
          indexerId: "go",
          checkoutPath,
          shardPath,
        }),
      ).rejects.toThrow("produced an empty shard")
      expect(existsSync(shardPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects a final shard that is not a regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "go.scip")
    await mkdir(checkoutPath)

    vi.stubGlobal("Bun", {
      spawn: vi.fn((argv: string[]) => {
        mkdirSync(argv.at(-1) as string)
        return fakeSubprocess(Promise.resolve(0))
      }),
    })

    try {
      await expect(
        runScipIndexer({
          indexerId: "go",
          checkoutPath,
          shardPath,
        }),
      ).rejects.toThrow("it is not a regular file")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
