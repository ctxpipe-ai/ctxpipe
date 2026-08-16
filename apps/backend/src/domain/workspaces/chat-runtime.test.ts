import { describe, expect, it } from "vitest"
import {
  WORKSPACE_CHAT_RUNTIME,
  workspaceChatRuntimeConfig,
  workspaceChatSandboxId,
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
      runtime.onPermissionRequest({ toolName: "git_push" }),
    ).resolves.toBe("deny")
    await expect(
      runtime.onPermissionRequest({ toolName: "apply_patch" }),
    ).resolves.toBe("allow")
  })
})
