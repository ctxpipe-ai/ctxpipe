import { describe, expect, it } from "vitest"
import { capSlackThreadMessages } from "./client.js"

describe("capSlackThreadMessages", () => {
  it("keeps short threads intact", () => {
    expect(capSlackThreadMessages(["a", "b"], false, 500)).toEqual({
      messages: ["a", "b"],
      truncated: false,
    })
  })

  it("truncates when over the cap", () => {
    expect(capSlackThreadMessages(["a", "b", "c"], false, 2)).toEqual({
      messages: ["a", "b"],
      truncated: true,
    })
  })

  it("marks truncated when the cap is exact but more pages remain", () => {
    expect(capSlackThreadMessages(["a", "b"], true, 2)).toEqual({
      messages: ["a", "b"],
      truncated: true,
    })
  })
})
