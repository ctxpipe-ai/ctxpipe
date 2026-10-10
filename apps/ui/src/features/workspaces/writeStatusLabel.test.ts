import { describe, expect, it } from "vitest"
import { writeStatusLabel } from "./writeStatusLabel"

describe("writeStatusLabel", () => {
  it("does not call unknown Read-only", () => {
    expect(writeStatusLabel("unknown")).toEqual({
      label: "Checking write access",
      tone: "pending",
      description:
        "Checking whether the GitHub App can push to this repository",
    })
    expect(writeStatusLabel("unknown").label).not.toBe("Read-only")
  })

  it("keeps writable and read_only honest", () => {
    expect(writeStatusLabel("writable")).toMatchObject({
      label: "Writable",
      tone: "writable",
    })
    expect(writeStatusLabel("read_only")).toMatchObject({
      label: "Read-only",
      tone: "read_only",
    })
  })

  it("describes read_only with the server reason when there is one", () => {
    expect(
      writeStatusLabel("read_only", "The GitHub App has no push access")
        .description,
    ).toBe("The GitHub App has no push access")
  })
})
