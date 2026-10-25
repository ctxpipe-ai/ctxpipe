import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_RUNTIME,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  WORKSPACE_CHAT_THREAD_SETUP,
  workspaceChatRuntimeConfig,
} from "./chat-runtime.js"
import { CONVERSATION_SANDBOX_GIT_EXCLUDE_LINES } from "./conversation-files.js"

describe("workspace chat runtime", () => {
  it("locks TanStack chat + withSandbox + opencodeText", () => {
    expect(WORKSPACE_CHAT_RUNTIME).toMatchObject({
      transport: "tanstack_chat",
      sandbox: "withSandbox",
      harness: "opencodeText",
      permissionMode: "acceptEdits",
    })
  })

  it("installs opencode in the sandbox and publishes the serve port", () => {
    expect(WORKSPACE_CHAT_OPENCODE_PORT).toBe(4096)
    expect(WORKSPACE_CHAT_SANDBOX_SETUP.join("\n")).toMatch(
      /command -v opencode/,
    )
    expect(WORKSPACE_CHAT_SANDBOX_SETUP.join("\n")).toMatch(
      /opencode-ai@1\.18\.34/,
    )
  })

  it("writes OpenCode config under HOME and excludes harness paths from git", () => {
    const cloneSetup = [
      WORKSPACE_CHAT_SANDBOX_SETUP[1],
      WORKSPACE_CHAT_THREAD_SETUP[1],
    ].join("\n")
    const repo = mkdtempSync(join(tmpdir(), "ws-chat-exclude-"))
    const home = mkdtempSync(join(tmpdir(), "ws-chat-opencode-home-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: repo })
    writeFileSync(join(repo, "README.md"), "already cloned\n")
    execFileSync("git", ["add", "README.md"], { cwd: repo })
    execFileSync(
      "git",
      [
        "-c",
        "user.email=setup@ctxpipe.test",
        "-c",
        "user.name=setup",
        "commit",
        "-m",
        "init",
      ],
      { cwd: repo },
    )
    const out = execFileSync(
      "sh",
      ["-c", `{ ${cloneSetup} ; } 2>&1; printf "\\n__BSSH_0__ $?\\n"`],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CTXPIPE_OPENCODE_JSON: '{"enabled_providers":["ctxpipe"]}',
        },
      },
    )
    expect(out).toMatch(/__BSSH_0__ 0/)
    expect(existsSync(join(repo, "opencode.json"))).toBe(false)
    expect(readFileSync(join(home, "opencode.json"), "utf8")).toContain(
      "enabled_providers",
    )
    const exclude = readFileSync(join(repo, ".git/info/exclude"), "utf8")
    for (const line of CONVERSATION_SANDBOX_GIT_EXCLUDE_LINES) {
      expect(exclude).toContain(line)
    }
  })

  it("lets the agent commit in a sandbox that has no Git identity", () => {
    const repo = mkdtempSync(join(tmpdir(), "ws-chat-identity-"))
    const home = mkdtempSync(join(tmpdir(), "ws-chat-identity-home-"))
    // A sandbox has no Git identity, and Git cannot guess one there from
    // the host name. useConfigOnly gives this host the same result.
    const globalConfig = join(home, ".gitconfig")
    writeFileSync(globalConfig, "[user]\n\tuseConfigOnly = true\n")
    const env = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    }
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env })
    execFileSync(
      "git",
      ["-c", "user.name=seed", "-c", "user.email=seed@example.test"].concat([
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "seed",
      ]),
      { cwd: repo, env },
    )
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim()
    // The checkout step, as for a fresh clone with no published branch.
    execFileSync("sh", ["-c", WORKSPACE_CHAT_THREAD_SETUP[0]], {
      cwd: repo,
      env: { ...env, CTXPIPE_CLONE_SHA: sha, CTXPIPE_CLONE_BRANCH: "main" },
    })
    writeFileSync(join(repo, "note.md"), "agent edit\n")
    execFileSync("git", ["add", "note.md"], { cwd: repo, env })
    execFileSync("git", ["commit", "-q", "-m", "docs: add note"], {
      cwd: repo,
      env,
    })
    expect(
      execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
        cwd: repo,
        env,
        encoding: "utf8",
      }).trim(),
    ).toBe("ctxpipe <workspace-chat@ctxpipe.local>")
  })

  it("puts opencode and GNU find on the backend image PATH", () => {
    const dockerfile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../Dockerfile"),
      "utf8",
    )
    expect(dockerfile).toMatch(/opencode-ai@1\.18\.34/)
    expect(dockerfile).toMatch(/findutils/)
  })

  it("exposes onPermissionRequest", async () => {
    const runtime = workspaceChatRuntimeConfig({
      writeStatus: "writable",
    })
    await expect(
      runtime.onPermissionRequest({
        id: "perm_1",
        sessionID: "sess_1",
        type: "git_push",
        title: "git_push",
      }),
    ).resolves.toBe("reject")
    await expect(
      runtime.onPermissionRequest({
        id: "perm_2",
        sessionID: "sess_1",
        type: "apply_patch",
        title: "apply_patch",
      }),
    ).resolves.toBe("once")
  })
})
