import { describe, expect, it } from "vitest"
import { activeHint } from "./hint-state"

describe("activeHint", () => {
  const all = ["create-pr", "panes", "add-workspace"] as const
  const base = {
    mounted: all,
    seen: [],
    newUser: true,
    modalOpen: false,
    createdWorkspace: false,
  }

  it("shows one hint at a time, in a fixed order", () => {
    expect(activeHint(base)).toBe("add-workspace")
    expect(activeHint({ ...base, seen: ["add-workspace"] })).toBe("panes")
  })

  it("shows only a hint whose anchor is on the page", () => {
    expect(activeHint({ ...base, mounted: ["panes"] })).toBe("panes")
    expect(activeHint({ ...base, mounted: [] })).toBeNull()
  })

  it("shows create-pr only after the panes hint was seen", () => {
    expect(activeHint({ ...base, mounted: ["create-pr"] })).toBeNull()
    expect(
      activeHint({ ...base, mounted: ["create-pr"], seen: ["panes"] }),
    ).toBe("create-pr")
  })

  it("never shows a seen hint, or any hint to an established user", () => {
    expect(
      activeHint({ ...base, seen: ["add-workspace", "panes", "create-pr"] }),
    ).toBeNull()
    expect(activeHint({ ...base, newUser: false })).toBeNull()
  })

  it("shows no hint while a modal dialog is open (CTX-863)", () => {
    expect(activeHint({ ...base, modalOpen: true })).toBeNull()
    expect(
      activeHint({ ...base, mounted: ["panes"], modalOpen: true }),
    ).toBeNull()
  })

  it("skips the add-workspace tip after the user created a Workspace (CTX-863)", () => {
    expect(activeHint({ ...base, createdWorkspace: true })).toBe("panes")
    expect(
      activeHint({
        ...base,
        mounted: ["add-workspace"],
        createdWorkspace: true,
      }),
    ).toBeNull()
  })
})
