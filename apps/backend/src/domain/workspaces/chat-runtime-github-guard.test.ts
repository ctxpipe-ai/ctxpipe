import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { WORKSPACE_CHAT_THREAD_SETUP } from "./chat-runtime.js"

// The real setup script in a real Git work tree, as a pool claim gives it:
// a clone at the desired commit. The remote does not answer, so a script
// that reaches it without the guard fails with another code.
let dir = ""
let sha = ""
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ctxpipe-guard-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("remote", "add", "origin", "https://127.0.0.1:9/none.git")
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "first",
  )
  sha = git("rev-parse", "HEAD")
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(env: Record<string, string>) {
  return spawnSync("sh", ["-c", WORKSPACE_CHAT_THREAD_SETUP[0]], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      CTXPIPE_GITHUB_PENDING: "1",
      CTXPIPE_CLONE_URL: "https://127.0.0.1:9/none.git",
      CTXPIPE_CLONE_BRANCH: "ctxpipe/chat/test",
      CTXPIPE_CLONE_SHA: sha,
      ...env,
    },
  }).status
}

describe("the thread setup without GitHub rules", () => {
  it("ends with no network command for a claim at the desired commit and no session branch", () => {
    expect(setup({})).toBe(0)
  })

  it("stops at a guard before it fetches a missing commit", () => {
    expect(setup({ CTXPIPE_CLONE_SHA: "b".repeat(40) })).toBe(75)
  })

  it("stops at a guard before it asks for the session branch", () => {
    expect(setup({ CTXPIPE_SESSION_BRANCH: "ctxpipe/chat/conv/1" })).toBe(75)
  })
})
