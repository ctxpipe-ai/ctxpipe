import { describe, expect, it } from "vitest"
import { activeHint } from "./hint-state"

describe("activeHint", () => {
  const all = ["create-pr", "panes", "add-workspace"] as const

  it("shows one hint at a time, in a fixed order", () => {
    expect(
      activeHint({ mounted: all, seen: [], newUser: true, modalOpen: false }),
    ).toBe("add-workspace")
    expect(
      activeHint({
        mounted: all,
        seen: ["add-workspace"],
        newUser: true,
        modalOpen: false,
      }),
    ).toBe("panes")
  })

  it("shows only a hint whose anchor is on the page", () => {
    expect(
      activeHint({
        mounted: ["panes"],
        seen: [],
        newUser: true,
        modalOpen: false,
      }),
    ).toBe("panes")
    expect(
      activeHint({ mounted: [], seen: [], newUser: true, modalOpen: false }),
    ).toBeNull()
  })

  it("shows create-pr only after the panes hint was seen", () => {
    expect(
      activeHint({
        mounted: ["create-pr"],
        seen: [],
        newUser: true,
        modalOpen: false,
      }),
    ).toBeNull()
    expect(
      activeHint({
        mounted: ["create-pr"],
        seen: ["panes"],
        newUser: true,
        modalOpen: false,
      }),
    ).toBe("create-pr")
  })

  it("never shows a seen hint, or any hint to an established user", () => {
    expect(
      activeHint({
        mounted: all,
        seen: ["add-workspace", "panes", "create-pr"],
        newUser: true,
        modalOpen: false,
      }),
    ).toBeNull()
    expect(
      activeHint({ mounted: all, seen: [], newUser: false, modalOpen: false }),
    ).toBeNull()
  })

  it("shows no hint while a modal dialog is open (CTX-863)", () => {
    expect(
      activeHint({ mounted: all, seen: [], newUser: true, modalOpen: true }),
    ).toBeNull()
    expect(
      activeHint({
        mounted: ["panes"],
        seen: [],
        newUser: true,
        modalOpen: true,
      }),
    ).toBeNull()
  })

  it("after the dialog closes, shows the due hint only if it is still due", () => {
    // Still due: the anchor is on the page and the hint is not seen.
    expect(
      activeHint({ mounted: all, seen: [], newUser: true, modalOpen: false }),
    ).toBe("add-workspace")
    // Not due now: the user saw the hint, or its anchor left the page.
    expect(
      activeHint({
        mounted: all,
        seen: ["add-workspace"],
        newUser: true,
        modalOpen: false,
      }),
    ).toBe("panes")
    expect(
      activeHint({ mounted: [], seen: [], newUser: true, modalOpen: false }),
    ).toBeNull()
  })
})
