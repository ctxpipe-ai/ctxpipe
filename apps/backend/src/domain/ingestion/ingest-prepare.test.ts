import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { copyCheckoutScript } from "./ingest-prepare.js"

/*
 * Real git on the host: the copy step of `sealIngestCheckout` (root runs the
 * same lines in the sandbox). The remote is a local bare repository that
 * allows a filter, so the user's copy is shallow and blobless, as a GitHub
 * source of a real shard is.
 */

let dir: string
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: date
      ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : env,
  }).trim()
}

function commit(work: string, files: Record<string, string>, date: string) {
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(work, path), content)
  git(work, ["add", "-A"])
  git(work, ["commit", "-q", "-m", date], date)
  return git(work, ["rev-parse", "HEAD"])
}

/** Run the copy lines as one script, as `sealIngestCheckout` does. */
function copy(input: Parameters<typeof copyCheckoutScript>[0]) {
  execFileSync(
    "sh",
    ["-c", ["set -e", ...copyCheckoutScript(input)].join("\n")],
    {
      encoding: "utf8",
      timeout: 60_000,
      env,
      stdio: "pipe",
    },
  )
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-prepare-"))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("copyCheckoutScript", () => {
  it("copies a shallow blobless checkout, and a read of an old blob fetches nothing", () => {
    const work = join(dir, "work")
    git(dir, ["init", "-q", "-b", "main", work])
    // The first commit is older than the 180-day window, so the clone is shallow.
    commit(
      work,
      { "a.txt": "old a\n", "b.txt": "old b\n" },
      "2025-01-01T00:00:00Z",
    )
    const mid = commit(work, { "a.txt": "mid a\n" }, "2026-08-01T00:00:00Z")
    const tip = commit(work, { "a.txt": "new a\n" }, "2026-09-01T00:00:00Z")
    const remote = join(dir, "remote.git")
    git(dir, ["clone", "-q", "--bare", work, remote])
    git(remote, ["config", "uploadpack.allowFilter", "true"])
    // The default user's clone in `prepareIngestShard`.
    const user = join(dir, "user")
    git(dir, [
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      "--shallow-since=2026-04-04",
      "--",
      `file://${remote}`,
      user,
    ])
    git(user, ["checkout", "-q", "--detach", tip])
    expect(git(user, ["rev-parse", "--is-shallow-repository"])).toBe("true")

    const sealed = join(dir, "sealed")
    copy({ from: user, to: sealed, remoteUrl: `file://${remote}` })

    expect(git(sealed, ["rev-parse", "HEAD"])).toBe(tip)
    expect(git(sealed, ["status", "--porcelain"])).toBe("")
    expect(readFileSync(join(sealed, "a.txt"), "utf8")).toBe("new a\n")
    expect(git(sealed, ["rev-parse", "--is-shallow-repository"])).toBe("true")
    expect(git(sealed, ["remote", "get-url", "origin"])).toBe(
      `file://${remote}`,
    )
    // The step has no git egress: an old blob that the copy lacks stays missing.
    expect(() => git(sealed, ["cat-file", "-e", `${mid}:a.txt`])).toThrow()
    expect(git(remote, ["cat-file", "blob", `${mid}:a.txt`])).toBe("mid a")
  })

  it("copies a full checkout on its branch", () => {
    const work = join(dir, "context")
    git(dir, ["init", "-q", "-b", "main", work])
    const tip = commit(
      work,
      { "README.md": "# Context\n" },
      "2026-09-01T00:00:00Z",
    )
    const sealed = join(dir, "context-sealed")
    copy({ from: work, to: sealed, remoteUrl: "/tmp/remote.git" })

    expect(git(sealed, ["rev-parse", "HEAD"])).toBe(tip)
    expect(git(sealed, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main")
    expect(git(sealed, ["status", "--porcelain"])).toBe("")
    expect(git(sealed, ["remote", "get-url", "origin"])).toBe("/tmp/remote.git")
  })
})
