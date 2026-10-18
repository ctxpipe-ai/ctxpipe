import { describe, expect, it } from "vitest"
import { editorSetupCommand } from "./editor-setup"

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
