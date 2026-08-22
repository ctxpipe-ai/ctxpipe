import { describe, expect, it } from "vitest"
import {
  afterFromSearch,
  workspaceCreateLandingSearch,
} from "./github-workspace-destination-nav"

describe("afterFromSearch", () => {
  it("reads after=settings from the create-workspace URL", () => {
    expect(afterFromSearch({ after: "settings" })).toBe("settings")
  })

  it("ignores other search values so SideNav create stays on files", () => {
    expect(afterFromSearch({})).toBeUndefined()
    expect(afterFromSearch({ after: "files" })).toBeUndefined()
    expect(afterFromSearch(undefined)).toBeUndefined()
  })
})

describe("workspaceCreateLandingSearch", () => {
  it("lands on Settings after GitHub setup create", () => {
    expect(workspaceCreateLandingSearch("settings")).toEqual({
      pane: "settings",
    })
  })

  it("leaves the default files pane when after is unset", () => {
    expect(workspaceCreateLandingSearch()).toBeUndefined()
  })
})
