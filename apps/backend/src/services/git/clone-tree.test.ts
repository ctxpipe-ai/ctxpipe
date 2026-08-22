import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  listMarkdownFilesAtGitSha,
  listPathsAtGitSha,
  readFileAtGitSha,
} from "./clone-tree.js"

const execFileAsync = promisify(execFile)

describe("clone-tree", () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it("lists paths and reads a blob at a stored SHA", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-clone-tree-"))
    await execFileAsync("git", ["init", dir])
    await execFileAsync("git", [
      "-C",
      dir,
      "config",
      "user.email",
      "dev@example.com",
    ])
    await execFileAsync("git", ["-C", dir, "config", "user.name", "Dev"])
    await writeFile(join(dir, "AGENTS.md"), "# Agents\n")
    await writeFile(join(dir, "notes.txt"), "hello\n")
    await execFileAsync("git", ["-C", dir, "add", "."])
    await execFileAsync("git", ["-C", dir, "commit", "-m", "seed"])
    const { stdout } = await execFileAsync("git", [
      "-C",
      dir,
      "rev-parse",
      "HEAD",
    ])
    const sha = stdout.trim()

    await expect(listPathsAtGitSha({ url: dir, sha })).resolves.toEqual(
      expect.arrayContaining(["AGENTS.md", "notes.txt"]),
    )
    await expect(listMarkdownFilesAtGitSha({ url: dir, sha })).resolves.toEqual(
      [{ path: "AGENTS.md", content: "# Agents\n" }],
    )
    await expect(
      readFileAtGitSha({ url: dir, sha, path: "notes.txt" }),
    ).resolves.toEqual({
      kind: "bytes",
      bytes: Buffer.from("hello\n"),
    })
    await expect(
      readFileAtGitSha({ url: dir, sha, path: "missing.md" }),
    ).resolves.toEqual({ kind: "missing" })
  })
})
