import { describe, expect, it } from "vitest"
import { isWorkspaceNavOpen, workspaceTitleAction } from "./nav"

describe("workspaceTitleAction", () => {
  it("composes when n=1", () => {
    expect(workspaceTitleAction({ workspaceCount: 1, isCurrent: true })).toBe(
      "compose",
    )
    expect(workspaceTitleAction({ workspaceCount: 1, isCurrent: false })).toBe(
      "compose",
    )
  })

  it("toggles the current Workspace when n>1", () => {
    expect(workspaceTitleAction({ workspaceCount: 2, isCurrent: true })).toBe(
      "toggle",
    )
  })

  it("resumes a different Workspace when n>1", () => {
    expect(workspaceTitleAction({ workspaceCount: 2, isCurrent: false })).toBe(
      "resume",
    )
  })
})

describe("isWorkspaceNavOpen", () => {
  it("stays expanded when n=1 even if the user did not expand", () => {
    expect(isWorkspaceNavOpen({ workspaceCount: 1, userExpanded: false })).toBe(
      true,
    )
  })

  it("follows user expansion when n>1", () => {
    expect(isWorkspaceNavOpen({ workspaceCount: 3, userExpanded: false })).toBe(
      false,
    )
    expect(isWorkspaceNavOpen({ workspaceCount: 3, userExpanded: true })).toBe(
      true,
    )
  })
})
