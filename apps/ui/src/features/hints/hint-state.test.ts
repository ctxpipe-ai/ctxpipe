import { describe, expect, it } from "vitest"
import { activeHint } from "./hint-state"

describe("activeHint", () => {
  const all = ["create-pr", "panes", "add-workspace"] as const

  it("shows one hint at a time, in a fixed order", () => {
    expect(activeHint({ mounted: all, seen: [], newUser: true })).toBe(
      "add-workspace",
    )
    expect(
      activeHint({ mounted: all, seen: ["add-workspace"], newUser: true }),
    ).toBe("panes")
  })

  it("shows only a hint whose anchor is on the page", () => {
    expect(activeHint({ mounted: ["panes"], seen: [], newUser: true })).toBe(
      "panes",
    )
    expect(activeHint({ mounted: [], seen: [], newUser: true })).toBeNull()
  })

  it("shows create-pr only after the panes hint was seen", () => {
    expect(
      activeHint({ mounted: ["create-pr"], seen: [], newUser: true }),
    ).toBeNull()
    expect(
      activeHint({ mounted: ["create-pr"], seen: ["panes"], newUser: true }),
    ).toBe("create-pr")
  })

  it("never shows a seen hint, or any hint to an established user", () => {
    expect(
      activeHint({
        mounted: all,
        seen: ["add-workspace", "panes", "create-pr"],
        newUser: true,
      }),
    ).toBeNull()
    expect(activeHint({ mounted: all, seen: [], newUser: false })).toBeNull()
  })
})
