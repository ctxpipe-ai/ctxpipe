import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  boundIndexerCache,
  removeIndexerRunDirs,
  withIndexerRunDir,
} from "./indexerCache.js"

let cacheDir: string

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "indexer-cache-"))
})

afterEach(async () => {
  await chmod(cacheDir, 0o755).catch(() => undefined)
  await removeIndexerRunDirs(cacheDir)
  await boundIndexerCache(cacheDir, 0)
  await rm(cacheDir, { recursive: true, force: true })
})

/** A Go module cache keeps its files and directories read-only. */
async function writeReadOnlyModule(bytes: number): Promise<void> {
  const moduleDir = join(cacheDir, "go", "pkg", "mod", "example.com", "m@v1")
  await mkdir(moduleDir, { recursive: true })
  await writeFile(join(moduleDir, "a.go"), Buffer.alloc(bytes))
  await chmod(join(moduleDir, "a.go"), 0o444)
  await chmod(moduleDir, 0o555)
}

describe("withIndexerRunDir", () => {
  it("gives the run an empty directory and removes it after success", async () => {
    let seen = ""
    const result = await withIndexerRunDir(cacheDir, async (runDir) => {
      seen = runDir
      expect(await readdir(runDir)).toEqual([])
      await writeFile(join(runDir, "scratch"), "x")
      return 42
    })
    expect(result).toBe(42)
    expect(seen.startsWith(join(cacheDir, "runs"))).toBe(true)
    expect(await readdir(join(cacheDir, "runs"))).toEqual([])
  })

  it("removes the directory after a failure, also with read-only content", async () => {
    await expect(
      withIndexerRunDir(cacheDir, async (runDir) => {
        const locked = join(runDir, "locked")
        await mkdir(locked)
        await writeFile(join(locked, "f"), "x")
        await chmod(locked, 0o555)
        throw new Error("indexer failed")
      }),
    ).rejects.toThrow("indexer failed")
    expect(await readdir(join(cacheDir, "runs"))).toEqual([])
  })
})

describe("boundIndexerCache", () => {
  it("keeps the cache when it is below the bound", async () => {
    await writeReadOnlyModule(64 * 1024)
    expect(await boundIndexerCache(cacheDir, 10 * 1024 * 1024)).toMatchObject({
      emptied: false,
    })
    expect(await readdir(cacheDir)).toEqual(["go"])
  })

  it("empties the cache, read-only Go modules too, when it is above the bound", async () => {
    await writeReadOnlyModule(256 * 1024)
    await mkdir(join(cacheDir, "npm"))
    await writeFile(join(cacheDir, "npm", "entry"), Buffer.alloc(1024))

    const result = await boundIndexerCache(cacheDir, 128 * 1024)

    expect(result.emptied).toBe(true)
    expect(result.bytes).toBeGreaterThan(128 * 1024)
    expect(await readdir(cacheDir)).toEqual([])
  })

  it("creates a missing cache directory", async () => {
    const missing = join(cacheDir, "not-yet")
    expect(await boundIndexerCache(missing, 1024)).toMatchObject({
      emptied: false,
    })
    expect(await readdir(missing)).toEqual([])
  })
})

describe("removeIndexerRunDirs", () => {
  it("removes the run directories that a crash left, and keeps the caches", async () => {
    const leftover = join(cacheDir, "runs", "crashed-run", "go-build123")
    await mkdir(leftover, { recursive: true })
    await chmod(leftover, 0o555)
    await mkdir(join(cacheDir, "go-build"))

    await removeIndexerRunDirs(cacheDir)

    expect(await readdir(cacheDir)).toEqual(["go-build"])
  })
})
