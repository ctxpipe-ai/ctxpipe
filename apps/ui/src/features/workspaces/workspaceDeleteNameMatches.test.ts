import { describe, expect, it } from "vitest"
import { workspaceDeleteNameMatches } from "./workspaceDeleteNameMatches"

describe("workspaceDeleteNameMatches", () => {
  it("matches the display name after trim", () => {
    expect(workspaceDeleteNameMatches("Docs", "Docs")).toBe(true)
    expect(workspaceDeleteNameMatches(" Docs ", "Docs")).toBe(true)
    expect(workspaceDeleteNameMatches("docs", "Docs")).toBe(false)
    expect(workspaceDeleteNameMatches("docs", "docs")).toBe(true)
  })
})
