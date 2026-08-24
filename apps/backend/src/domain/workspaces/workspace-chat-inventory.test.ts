import { describe, expect, it, vi } from "vitest"
import {
  renderWorkspaceInventoryMarkdown,
  writeChatSandboxInventory,
  WORKSPACE_CHAT_INVENTORY_PATH,
} from "./workspace-chat-inventory.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"

describe("renderWorkspaceInventoryMarkdown", () => {
  it("renders a compact org-scoped file list with excerpts", () => {
    const markdown = renderWorkspaceInventoryMarkdown({
      paths: ["AGENTS.md", "README.md", "knowledge/billing.md"],
      agentsExcerpt: "Use knowledge/ for durable facts.",
      readmeExcerpt: "Context workspace.",
    })
    expect(markdown).toContain("# Workspace inventory")
    expect(markdown).toContain("- AGENTS.md")
    expect(markdown).toContain("- knowledge/billing.md")
    expect(markdown).toContain("Use knowledge/ for durable facts.")
    expect(markdown).toContain("Context workspace.")
    expect(markdown).not.toContain("/tmp/tanstack-ai-sandboxes")
  })
})

describe("writeChatSandboxInventory", () => {
  it("writes inventory from git ls-files and file excerpts", async () => {
    const write = vi.fn(async () => undefined)
    const mkdir = vi.fn(async () => undefined)
    const exec = vi.fn(async (command: string) => {
      if (command.includes("git ls-files")) {
        return { stdout: "AGENTS.md\nREADME.md\n", stderr: "", exitCode: 0 }
      }
      if (command.includes("AGENTS.md")) {
        return { stdout: "Agents excerpt", stderr: "", exitCode: 0 }
      }
      return { stdout: "Readme excerpt", stderr: "", exitCode: 0 }
    })
    const handle = {
      process: { exec },
      fs: { write, mkdir, read: async () => "", remove: async () => undefined },
      destroy: async () => undefined,
    } satisfies TanstackLikeHandle
    await writeChatSandboxInventory({ handle })
    expect(write).toHaveBeenCalledWith(
      WORKSPACE_CHAT_INVENTORY_PATH,
      expect.stringContaining("- AGENTS.md"),
    )
    expect(mkdir).toHaveBeenCalledWith(".ctxpipe")
  })
})
