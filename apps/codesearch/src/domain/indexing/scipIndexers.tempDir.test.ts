import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, expect, it, vi } from "vitest"

// The indexer cache is the sibling `indexer-cache` of REPO_CACHE_DIR, which
// paths.ts reads when it is imported.
const root = mkdtempSync(join(tmpdir(), "scip-temp-dir-"))
vi.stubEnv("REPO_CACHE_DIR", join(root, "repo-cache"))

const { runScipIndexer } = await import("./scipIndexers.js")

const runsDir = join(root, "indexer-cache", "runs")

afterEach(() => vi.unstubAllGlobals())
afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function stubSpawn(exitCode: number) {
  const seen: { env?: Record<string, string>; existed?: boolean } = {}
  vi.stubGlobal("Bun", {
    spawn: vi.fn((argv: string[], options: { env: Record<string, string> }) => {
      seen.env = options.env
      seen.existed = existsSync(options.env.TMPDIR ?? "")
      writeFileSync(argv[argv.indexOf("--output") + 1] as string, "index")
      return {
        exited: Promise.resolve(exitCode),
        stdout: null,
        stderr: null,
        resourceUsage: () => undefined,
      }
    }),
  })
  return seen
}

async function runGo() {
  const checkoutPath = join(root, "checkout")
  await mkdir(checkoutPath, { recursive: true })
  return runScipIndexer({
    indexerId: "go",
    checkoutPath,
    shardPath: join(root, "shards", "go.scip"),
  })
}

it("gives the indexer its own temp directory and removes it after success", async () => {
  const seen = stubSpawn(0)
  await runGo()
  expect(seen.env?.TMPDIR?.startsWith(runsDir)).toBe(true)
  expect(seen.env?.GOTMPDIR).toBe(seen.env?.TMPDIR)
  expect(seen.existed).toBe(true)
  expect(await readdir(runsDir)).toEqual([])
})

it("removes the temp directory after a failed indexer", async () => {
  const seen = stubSpawn(1)
  await expect(runGo()).rejects.toThrow(/exit code 1/)
  expect(seen.existed).toBe(true)
  expect(await readdir(runsDir)).toEqual([])
})
