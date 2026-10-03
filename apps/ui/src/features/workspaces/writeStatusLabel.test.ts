import { describe, expect, it } from "vitest"
import { writeStatusLabel } from "./writeStatusLabel"

describe("writeStatusLabel", () => {
  it("does not call unknown Read-only", () => {
    expect(writeStatusLabel("unknown")).toEqual({
      label: "Checking write access",
      tone: "pending",
    })
    expect(writeStatusLabel("unknown").label).not.toBe("Read-only")
  })

  it("keeps writable and read_only honest", () => {
    expect(writeStatusLabel("writable")).toEqual({
      label: "Writable",
      tone: "writable",
    })
    expect(writeStatusLabel("read_only")).toEqual({
      label: "Read-only",
      tone: "read_only",
    })
  })
})
