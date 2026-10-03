import { describe, expect, it } from "vitest"
import { parseSideNavLocation, sideNavLocationKey } from "./sideNavLocation"

describe("parseSideNavLocation", () => {
  it("reads Home, Connectors, and workspace paths", () => {
    expect(parseSideNavLocation("/acme", null)).toEqual({
      orgSlug: "acme",
      primary: "home",
    })
    expect(parseSideNavLocation("/acme/connectors", null)).toEqual({
      orgSlug: "acme",
      primary: "connectors",
    })
    expect(parseSideNavLocation("/acme/organization/settings", null)).toEqual({
      orgSlug: "acme",
      primary: "other",
    })
  })

  it("keys org with workspace so ids do not leak", () => {
    expect(
      sideNavLocationKey({
        orgSlug: "acme",
        primary: "workspace",
        workspaceSlug: "docs",
      }),
    ).toBe("acme/workspace/docs/")
  })
})
