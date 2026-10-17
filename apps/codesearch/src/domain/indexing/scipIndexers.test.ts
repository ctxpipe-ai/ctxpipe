import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeScipIndex, encodeScipIndex } from "../graph/scipProto.js"
import type { ScipIndexerId } from "./detectLanguages.js"
import {
  runScipIndexer,
  SCIP_INDEXER_ARGV,
  SCIP_INDEXER_OUTPUT_FLAG,
} from "./scipIndexers.js"

function fakeSubprocess(
  exited: Promise<number>,
  stdout?: string,
): ReturnType<typeof Bun.spawn> {
  return {
    exited,
    stdout: stdout === undefined ? null : new Response(stdout).body,
    stderr: null,
    resourceUsage: () => ({
      maxRSS: 0,
      cpuTime: { user: 0n, system: 0n, total: 0n },
    }),
  } as unknown as ReturnType<typeof Bun.spawn>
}

/** Shard path an indexer writes: after `--output`, else the last argument. */
function outputOf(argv: string[]): string {
  const flag = argv.indexOf("--output")
  return (flag >= 0 ? argv[flag + 1] : argv.at(-1)) as string
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
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
    writeFileSync(join(checkoutPath, "tsconfig.json"), "{}")

    const exits: Array<() => void> = []
    const spawn = vi.fn((argv: string[]) => {
      writeFileSync(outputOf(argv), `index-${exits.length}`)
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
        expect.stringMatching(/\.typescript\.scip\..+\.tmp$/),
        join(checkoutPath, "tsconfig.json"),
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

  it("limits raw parallel polyglot indexer spawns to two processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    await mkdir(checkoutPath)
    writeFileSync(join(checkoutPath, "tsconfig.json"), "{}")

    const exits: Array<() => void> = []
    const spawn = vi.fn((argv: string[]) => {
      writeFileSync(outputOf(argv), `index-${exits.length}`)
      let resolveExit: () => void = () => undefined
      const exited = new Promise<number>((resolve) => {
        resolveExit = () => resolve(0)
      })
      exits.push(resolveExit)
      return fakeSubprocess(exited)
    })
    vi.stubGlobal("Bun", { spawn })

    const runs = (["go", "typescript", "python"] as const).map((indexerId) =>
      runScipIndexer({
        indexerId,
        checkoutPath,
        shardPath: join(directory, "shards", `${indexerId}.scip`),
      }),
    )

    try {
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
      expect(spawn).toHaveBeenCalledTimes(2)

      exits[0]?.()
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3))

      for (const resolveExit of exits) resolveExit()
      await Promise.all(runs)
      expect(spawn.mock.calls.map(([argv]) => argv[0]).sort()).toEqual([
        "scip-go",
        "scip-python",
        "scip-typescript",
      ])
    } finally {
      for (const resolveExit of exits) resolveExit()
      await Promise.allSettled(runs)
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

  it("maps SIGKILL exit 137 to the memory-fit error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "go.scip")
    await mkdir(checkoutPath)

    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => fakeSubprocess(Promise.resolve(137))),
    })

    try {
      await expect(
        runScipIndexer({
          indexerId: "go",
          checkoutPath,
          shardPath,
        }),
      ).rejects.toThrow("Codebase didn't fit available memory")
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

  it("indexes every monorepo project deepest first and reports the ones that failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "typescript.scip")
    writeFiles(checkoutPath, {
      "pnpm-workspace.yaml": "packages: ['packages/*']",
      "tsconfig.json": '{ "exclude": ["dist"] }',
      "packages/config/package.json": '{"name":"@acme/config"}',
      "packages/config/tsconfig.json": "{}",
      "packages/app/tsconfig.json": "{}",
      "packages/app/test/tsconfig.json": "{}",
      "packages/broken/tsconfig.json": "{}",
      "packages/empty/tsconfig.json": "{}",
    })

    const documents: Record<string, string[]> = {
      "packages/app/test/tsconfig.json": ["packages/app/test/a.test.ts"],
      "packages/app/tsconfig.ctxpipe-scip.json": [
        "packages/app/main.ts",
        "packages/config/base.ts",
      ],
      "packages/config/tsconfig.json": ["packages/config/base.ts"],
      "tsconfig.ctxpipe-scip.json": ["scripts/release.ts"],
    }
    let rootConfig: unknown
    const spawn = vi.fn((argv: string[], _options?: object) => {
      expect(
        lstatSync(
          join(checkoutPath, "node_modules", "@acme", "config"),
        ).isSymbolicLink(),
      ).toBe(true)
      const config = relative(checkoutPath, argv.at(-1) as string)
      if (config === "tsconfig.ctxpipe-scip.json") {
        rootConfig = JSON.parse(readFileSync(argv.at(-1) as string, "utf8"))
      }
      if (config === "packages/empty/tsconfig.json") {
        return fakeSubprocess(Promise.resolve(1), "error: no files got indexed")
      }
      const paths = documents[config]
      if (!paths) return fakeSubprocess(Promise.resolve(1))
      writeFileSync(
        outputOf(argv),
        encodeScipIndex({
          documents: paths.map((relativePath) => ({ relativePath })),
        }),
      )
      return fakeSubprocess(Promise.resolve(0))
    })
    vi.stubGlobal("Bun", { spawn })

    try {
      const result = await runScipIndexer({
        indexerId: "typescript",
        checkoutPath,
        shardPath,
      })

      expect(
        spawn.mock.calls.map(([argv]) =>
          relative(checkoutPath, argv.at(-1) as string),
        ),
      ).toEqual([
        "packages/app/test/tsconfig.json",
        "packages/app/tsconfig.ctxpipe-scip.json",
        "packages/broken/tsconfig.json",
        "packages/config/tsconfig.json",
        "packages/empty/tsconfig.json",
        "tsconfig.ctxpipe-scip.json",
      ])
      expect(rootConfig).toEqual({
        extends: "./tsconfig.json",
        exclude: [
          "dist",
          "packages/app",
          "packages/broken",
          "packages/config",
          "packages/empty",
          "packages/app/test",
        ],
      })
      expect(spawn.mock.calls[0]?.[1]).toMatchObject({
        env: {
          NODE_OPTIONS: expect.stringMatching(/^--max-old-space-size=\d+$/),
        },
      })
      expect(result).toEqual({
        issue:
          "TypeScript code intelligence is incomplete: 1 of 6 projects could not be indexed (packages/broken)",
      })
      expect(
        decodeScipIndex(readFileSync(shardPath)).documents?.map(
          (document) => (document as { relativePath: string }).relativePath,
        ),
      ).toEqual([
        "packages/app/test/a.test.ts",
        "packages/app/main.ts",
        "packages/config/base.ts",
        "scripts/release.ts",
      ])
      for (const leftover of [
        "node_modules",
        "package.json",
        "tsconfig.ctxpipe-scip.json",
        "packages/app/tsconfig.ctxpipe-scip.json",
      ]) {
        expect(existsSync(join(checkoutPath, leftover))).toBe(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("retries a project whose extends base is not installed without it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "typescript.scip")
    writeFiles(checkoutPath, {
      "tsconfig.json":
        '{ "extends": "@tsconfig/node16/tsconfig.json", "include": ["src"] }',
    })
    let standalone: unknown
    const spawn = vi.fn((argv: string[], _options?: object) => {
      const config = argv.at(-1) as string
      if (config.endsWith("/tsconfig.json")) {
        return fakeSubprocess(
          Promise.resolve(1),
          "error TS6053: File '@tsconfig/node16/tsconfig.json' not found.\nerror: no files got indexed",
        )
      }
      standalone = JSON.parse(readFileSync(config, "utf8"))
      writeFileSync(
        outputOf(argv),
        encodeScipIndex({ documents: [{ relativePath: "src/a.ts" }] }),
      )
      return fakeSubprocess(Promise.resolve(0))
    })
    vi.stubGlobal("Bun", { spawn })

    try {
      await expect(
        runScipIndexer({ indexerId: "typescript", checkoutPath, shardPath }),
      ).resolves.toEqual({})
      expect(standalone).toEqual({
        include: ["src"],
        exclude: ["node_modules", "bower_components", "jspm_packages"],
        compilerOptions: {},
      })
      expect(decodeScipIndex(readFileSync(shardPath)).documents).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("fails the TypeScript shard when no project of a TypeScript repository indexed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "typescript.scip")
    writeFiles(checkoutPath, { "tsconfig.json": "{}" })

    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => fakeSubprocess(Promise.resolve(1))),
    })

    try {
      await expect(
        runScipIndexer({ indexerId: "typescript", checkoutPath, shardPath }),
      ).rejects.toThrow('SCIP indexer "typescript" failed with exit code 1')
      expect(existsSync(shardPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("soft-skips with an empty shard when incidental nested TypeScript fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    const shardPath = join(directory, "shards", "typescript.scip")
    writeFiles(checkoutPath, {
      "go.mod": "module example.com/app",
      "docs/site/tsconfig.json": '{ "extends": "@tsconfig/node20" }',
    })

    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => fakeSubprocess(Promise.resolve(1))),
    })

    try {
      await expect(
        runScipIndexer({ indexerId: "typescript", checkoutPath, shardPath }),
      ).resolves.toEqual({})
      expect(decodeScipIndex(readFileSync(shardPath))).toEqual({
        documents: [],
        externalSymbols: [],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("does not pass the service NODE_OPTIONS to indexers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-indexers-"))
    const checkoutPath = join(directory, "checkout")
    await mkdir(checkoutPath)
    const spawn = vi.fn((argv: string[], _options?: object) => {
      writeFileSync(outputOf(argv), "index")
      return fakeSubprocess(Promise.resolve(0))
    })
    vi.stubGlobal("Bun", { spawn })

    try {
      await runScipIndexer({
        indexerId: "python",
        checkoutPath,
        shardPath: join(directory, "shards", "python.scip"),
        env: { NODE_OPTIONS: "--require ./preload.js" },
      })
      expect(spawn.mock.calls[0]?.[1]).not.toHaveProperty("env.NODE_OPTIONS")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
