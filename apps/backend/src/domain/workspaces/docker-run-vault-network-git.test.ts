import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { describe, expect, it } from "vitest"

import { SANDBOX_READ_GIT } from "./chat-runtime.js"
import { withGithubBeforeNetworkGit } from "./docker-run-vault.js"

// The sandbox is the environment: a provider whose sandbox records each call
// in one log with the vault's GitHub mints.
function recording() {
  const log: string[] = []
  const handle = {
    id: "sbx",
    process: {
      exec: async (command: string) => {
        log.push(`exec ${command}`)
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      spawn: async (command: string) => {
        log.push(`spawn ${command}`)
        return { pid: 1, wait: async () => 0, kill: async () => undefined }
      },
    },
    git: {
      clone: async () => {
        log.push("git.clone")
      },
      push: async () => {
        log.push("git.push")
      },
      pull: async () => {
        log.push("git.pull")
      },
    },
    destroy: async () => undefined,
  } as unknown as SandboxHandle
  const provider = {
    name: "recording",
    capabilities: () => ({}),
    create: async () => handle,
    resume: async () => handle,
    destroy: async () => undefined,
  } as unknown as SandboxProvider
  let mints = 0
  let rules: Promise<void> | undefined
  const github = () => {
    rules ??= (async () => {
      mints += 1
      log.push("mint")
    })()
    return rules
  }
  return { provider, log, github, mints: () => mints }
}

describe("withGithubBeforeNetworkGit", () => {
  it("mints nothing for commands that do not reach GitHub", async () => {
    const r = recording()
    const handle = await withGithubBeforeNetworkGit(
      r.provider,
      r.github,
    ).create({})

    await handle.process.exec('git cat-file -e "$NEW_SHA^{commit}"')
    await handle.process.exec("git rev-parse HEAD")
    await handle.process.spawn("opencode serve --port=4096")

    expect(r.mints()).toBe(0)
  })

  it("mints once, before the first command that reaches GitHub", async () => {
    const r = recording()
    const handle = await withGithubBeforeNetworkGit(
      r.provider,
      r.github,
    ).resume({ id: "sbx" })

    await handle.process.exec("git rev-parse HEAD")
    await handle.process.exec(
      `git cat-file -e "$S" || ${SANDBOX_READ_GIT} fetch -q --depth 1 origin "$S"`,
    )
    await handle.git.clone({ url: "https://github.com/o/r.git" })
    await handle.git.push()
    await handle.process.spawn("git push origin HEAD")

    expect(r.log[0]).toBe("exec git rev-parse HEAD")
    expect(r.log[1]).toBe("mint")
    expect(r.log.slice(2).map((entry) => entry.split(" ")[0])).toEqual([
      "exec",
      "git.clone",
      "git.push",
      "spawn",
    ])
    expect(r.mints()).toBe(1)
  })

  it("runs no command that reaches GitHub when the mint fails", async () => {
    const r = recording()
    const handle = await withGithubBeforeNetworkGit(r.provider, () =>
      Promise.reject(new Error("mint failed")),
    ).create({})

    await expect(
      handle.git.clone({ url: "https://github.com/o/r.git" }),
    ).rejects.toThrow("mint failed")
    await expect(handle.process.exec("git fetch origin")).rejects.toThrow(
      "mint failed",
    )
    expect(r.log).toEqual([])
  })
})
