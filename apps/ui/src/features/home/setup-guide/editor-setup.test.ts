import HyperDX from "@hyperdx/browser"
import { describe, expect, it, vi } from "vitest"
import {
  editorSetupCommand,
  recordMcpConfigCopied,
} from "./editor-setup"

describe("editorSetupCommand", () => {
  it("is the bare command on the hosted origin", () => {
    expect(editorSetupCommand("https://app.ctxpipe.ai")).toBe(
      "npx ctxpipe init",
    )
  })

  it("adds the origin as --base-url on another deployment", () => {
    expect(editorSetupCommand("https://backend-pr-280.up.railway.app")).toBe(
      "npx ctxpipe init --base-url https://backend-pr-280.up.railway.app",
    )
    expect(editorSetupCommand("http://localhost:3000")).toBe(
      "npx ctxpipe init --base-url http://localhost:3000",
    )
  })
})

describe("recordMcpConfigCopied", () => {
  it("records mcp_config_copy with the part that the user copied, and not the value", () => {
    const addAction = vi
      .spyOn(HyperDX, "addAction")
      .mockImplementation(() => {})

    recordMcpConfigCopied("setup_command")

    expect(addAction.mock.calls).toEqual([
      ["mcp_config_copy", { target: "setup_command" }],
    ])
    addAction.mockRestore()
  })
})
