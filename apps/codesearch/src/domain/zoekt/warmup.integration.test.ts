import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { pinRepos, resetPinManagerForTests } from "./pinManager.js"
import {
  listLoadedZoektRepoIds,
  waitUntilZoektReposLoaded,
  ZoektWarmupTimeoutError,
} from "./warmup.js"

const hasZoekt = (() => {
  const dirs = (process.env.PATH ?? "").split(":")
  const find = (bin: string) => dirs.some((dir) => existsSync(join(dir, bin)))
  return find("zoekt-index") && find("zoekt-webserver")
})()

describe.skipIf(!hasZoekt)(
  "zoekt hot/cold warmup (real zoekt-webserver)",
  () => {
    let tmpDir: string
    let coldDir: string
    let hotDir: string
    let srcDir: string
    let webserver: ChildProcess | null = null
    let baseUrl: string
    const zoektRepoId = 42
    const repoName = "owner/repo"

    function run(cmd: string[], cwd?: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(cmd[0]!, cmd.slice(1), {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stderr = ""
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.on("error", reject)
        child.on("close", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`${cmd.join(" ")} failed (${code}): ${stderr}`))
        })
      })
    }

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "zoekt-warmup-"))
      coldDir = join(tmpDir, "zoekt-index")
      hotDir = join(tmpDir, "zoekt-hot")
      srcDir = join(tmpDir, "src")
      await mkdir(coldDir, { recursive: true })
      await mkdir(hotDir, { recursive: true })
      await mkdir(srcDir, { recursive: true })
      await writeFile(join(srcDir, "a.txt"), "hello needle world\n")

      const metaPath = join(tmpDir, "meta.json")
      await writeFile(
        metaPath,
        JSON.stringify({
          ID: zoektRepoId,
          Name: repoName,
          URL: "https://example.com/owner/repo",
          Source: srcDir,
        }),
      )

      await run(["zoekt-index", "-index", coldDir, "-meta", metaPath, srcDir])

      const port = 19000 + Math.floor(Math.random() * 1000)
      baseUrl = `http://127.0.0.1:${port}`
      webserver = spawn(
        "zoekt-webserver",
        ["-index", hotDir, "-rpc", "-listen", `:${port}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try {
          const loaded = await listLoadedZoektRepoIds(baseUrl)
          expect(loaded.size).toBe(0)
          return
        } catch {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      throw new Error("zoekt-webserver did not become ready")
    }, 60_000)

    afterAll(async () => {
      resetPinManagerForTests()
      if (webserver) {
        webserver.kill("SIGTERM")
        await new Promise<void>((resolve) => {
          webserver?.once("exit", () => resolve())
          setTimeout(resolve, 2000)
        })
      }
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    })

    it("search stays empty until pin; warmup wait succeeds after pin", async () => {
      resetPinManagerForTests()

      const before = await fetch(`${baseUrl}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Q: "needle", RepoIDs: [zoektRepoId] }),
      })
      expect(before.ok).toBe(true)
      const beforeBody = (await before.json()) as {
        Result?: { ShardsScanned?: number; MatchCount?: number }
      }
      expect(beforeBody.Result?.ShardsScanned ?? 0).toBe(0)
      expect(beforeBody.Result?.MatchCount ?? 0).toBe(0)

      // Cold miss is not an HTTP error — list stays empty until pin.
      await expect(
        waitUntilZoektReposLoaded({
          repoIds: [zoektRepoId],
          baseUrl,
          timeoutMs: 400,
          pollIntervalMs: 50,
        }),
      ).rejects.toBeInstanceOf(ZoektWarmupTimeoutError)

      const pinResults = await pinRepos([{ zoektRepoId, repoName }], {
        coldDir,
        hotDir,
        idleTtlMs: 60_000,
      })
      expect(pinResults[0]?.shardCount).toBeGreaterThan(0)

      await waitUntilZoektReposLoaded({
        repoIds: [zoektRepoId],
        baseUrl,
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      })

      const after = await fetch(`${baseUrl}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Q: "needle", RepoIDs: [zoektRepoId] }),
      })
      expect(after.ok).toBe(true)
      const afterBody = (await after.json()) as {
        Result?: { ShardsScanned?: number; MatchCount?: number }
      }
      expect(afterBody.Result?.ShardsScanned ?? 0).toBeGreaterThan(0)
      expect(afterBody.Result?.MatchCount ?? 0).toBeGreaterThan(0)
    }, 30_000)
  },
)
