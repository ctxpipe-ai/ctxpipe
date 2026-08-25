import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  WORKSPACE_CHAT_DOCKER_SANDBOX,
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_RUNTIME,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  workspaceChatGitSource,
  workspaceChatLiveSandboxId,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
  workspaceChatSandboxSpec,
} from "./chat-runtime.js"

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
    expect(WORKSPACE_CHAT_DOCKER_SANDBOX).toEqual({
      image: "node:22",
      publishPorts: [4096],
    })
    expect(WORKSPACE_CHAT_SANDBOX_SETUP.join("\n")).toMatch(
      /command -v opencode/,
    )
    expect(WORKSPACE_CHAT_SANDBOX_SETUP.join("\n")).toMatch(
      /opencode-ai@1\.18\.18/,
    )
  })

  it("does not exit the TanStack bootstrap shell when a worktree already exists", () => {
    const setup = WORKSPACE_CHAT_SANDBOX_SETUP.join("\n")
    expect(setup).not.toMatch(/\bexit\b/)
    expect(setup).not.toMatch(/\bset -e\b/)

    const cloneSetup = WORKSPACE_CHAT_SANDBOX_SETUP[1]
    const home = mkdtempSync(join(tmpdir(), "ws-chat-setup-"))
    execFileSync("git", ["init", "-b", "main"], { cwd: home })
    writeFileSync(join(home, "README.md"), "already cloned\n")
    execFileSync("git", ["add", "README.md"], { cwd: home })
    execFileSync(
      "git",
      ["-c", "user.email=setup@ctxpipe.test", "-c", "user.name=setup", "commit", "-m", "init"],
      { cwd: home },
    )
    const out = execFileSync(
      "sh",
      ["-c", `{ ${cloneSetup} ; } 2>&1; printf "\\n__BSSH_0__ $?\\n"`],
      { cwd: home, encoding: "utf8" },
    )
    expect(out).toMatch(/__BSSH_0__ 0/)
  })

  it("puts opencode and GNU find on the backend image PATH", () => {
    const dockerfile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../Dockerfile"),
      "utf8",
    )
    expect(dockerfile).toMatch(/opencode-ai@1\.18\.18/)
    expect(dockerfile).toMatch(/findutils/)
  })

  it("keys the sandbox by org, workspace, desired URL, and SHA", () => {
    expect(
      workspaceChatSandboxId({
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        image: "chat:1",
      }),
    ).toBe("org_1:ws_1:https://github.com/acme/docs@abc:chat:1")
    expect(
      workspaceChatLiveSandboxId({
        snapshotId: "org_1:ws_1:https://github.com/acme/docs@abc:chat:1",
        conversationId: "conv_1",
      }),
    ).toBe("org_1:ws_1:https://github.com/acme/docs@abc:chat:1:thread:conv_1")
    expect(
      workspaceChatSandboxId({
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: null,
        image: "chat:1",
      }),
    ).toBeNull()
  })

  it("detects the provider and exposes onPermissionRequest", async () => {
    const runtime = workspaceChatRuntimeConfig({
      env: { SANDBOX_PROVIDER: "docker" },
      writeStatus: "writable",
    })
    expect(runtime.provider).toBe("docker")
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

  it("builds a thread-reuse sandbox spec and refuses Railway without a provider", () => {
    expect(
      workspaceChatSandboxSpec({
        sandboxId: "sbx_1",
        provider: "docker",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
      }),
    ).toMatchObject({
      ok: true,
      isolation: "docker",
      source: { type: "git", url: "https://github.com/acme/docs", ref: "abc" },
      lifecycle: { reuse: "thread", keepAlive: "30m" },
    })
    expect(
      workspaceChatSandboxSpec({
        sandboxId: "sbx_1",
        provider: "unsandboxed",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
      }),
    ).toEqual({ ok: false, reason: "no_isolated_provider" })
    expect(
      workspaceChatSandboxSpec({
        sandboxId: "sbx_1",
        provider: "railway",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
      }),
    ).toEqual({ ok: false, reason: "no_isolated_provider" })
    expect(
      workspaceChatGitSource({
        url: "https://github.com/acme/docs",
        ref: "abc",
        token: { __secretName: "CTXPIPE_CLONE_TOKEN" },
      }),
    ).toEqual({
      url: "https://github.com/acme/docs",
      ref: "abc",
      auth: { token: { __secretName: "CTXPIPE_CLONE_TOKEN" } },
    })
  })
})
