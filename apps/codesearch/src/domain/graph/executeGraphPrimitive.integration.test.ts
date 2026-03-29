import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { executeCgcGraphQuery } from "./executeGraphPrimitive.js"

const fixtureRepo = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures/minimal-repo",
)

const pyImport = spawnSync("python3", ["-c", "import codegraphcontext"], {
  encoding: "utf8",
})
const cgcHelp = spawnSync("cgc", ["--help"], { encoding: "utf8" })
const cgcWatchHelp = spawnSync("cgc", ["watch", "--help"], {
  encoding: "utf8",
})

const cgcStackAvailable =
  pyImport.status === 0 && cgcHelp.status === 0 && cgcWatchHelp.status === 0

describe.skipIf(!cgcStackAvailable)(
  "executeCgcGraphQuery (CGC + Kùzu integration)",
  { timeout: 120_000 },
  () => {
    let kuzuDir: string | undefined
    let kuzuDbPath: string

    beforeAll(() => {
      expect(
        existsSync(fixtureRepo),
        `fixture repo missing at ${fixtureRepo} (run tests via apps/codesearch package test script)`,
      ).toBe(true)

      kuzuDir = mkdtempSync(join(tmpdir(), "cgc-graph-int-"))
      kuzuDbPath = join(kuzuDir, "graph.kuzu")

      const index = spawnSync("cgc", ["index", ".", "--force"], {
        cwd: fixtureRepo,
        env: {
          ...process.env,
          KUZUDB_PATH: kuzuDbPath,
          DATABASE_TYPE: "kuzudb",
        },
        encoding: "utf8",
      })
      expect(
        index.status,
        `cgc index failed:\n${index.stderr}\n${index.stdout}`,
      ).toBe(0)
      expect(existsSync(kuzuDbPath), "Kùzu database file was not created").toBe(
        true,
      )
    })

    afterAll(() => {
      if (kuzuDir) {
        rmSync(kuzuDir, { recursive: true, force: true })
      }
    })

    it("runs find_symbol against indexed fixture", async () => {
      const res = await executeCgcGraphQuery({
        primitive: "find_symbol",
        kuzuDbPath,
        repoPath: fixtureRepo,
        symbol: "public_entry",
      })
      expect(res.ok, res.error ?? res.note).toBe(true)
      expect(Array.isArray(res.results)).toBe(true)
      expect(res.results.length).toBeGreaterThan(0)
      const blob = JSON.stringify(res.results)
      expect(blob).toContain("public_entry")
    })
  },
)
