import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runGit } from "./run-git.js"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "run-git-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("runGit", () => {
  it("lets the git exit status decide when git exits before it reads a large input", async () => {
    const input = Buffer.alloc(16 * 1024 * 1024, 0x61)
    for (let i = 0; i < 5; i++)
      await expect(
        runGit(dir, ["rev-parse", "--verify", "missing-ref"], { input }),
      ).rejects.toThrow(/git rev-parse failed/)
  })

  it("returns stdout when git succeeds after a large input", async () => {
    const input = Buffer.alloc(4 * 1024 * 1024, 0x62)
    const out = await runGit(dir, ["hash-object", "--stdin"], { input })
    expect(out.toString().trim()).toMatch(/^[0-9a-f]{40}$/)
  })
})
