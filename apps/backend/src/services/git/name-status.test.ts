import { expect, it } from "vitest"
import { parseNameStatus } from "./name-status.js"

it("reads one path for most changes and two paths for a rename or a copy", () => {
  expect(
    parseNameStatus(
      Buffer.from(
        "A\0new.md\0D\0old.md\0M\0a b.md\0R087\0from.md\0to.md\0C100\0x.md\0y.md\0",
      ),
    ),
  ).toEqual([
    { status: "A", from: "new.md", to: "new.md" },
    { status: "D", from: "old.md", to: "old.md" },
    { status: "M", from: "a b.md", to: "a b.md" },
    { status: "R087", from: "from.md", to: "to.md" },
    { status: "C100", from: "x.md", to: "y.md" },
  ])
})

it("reads empty output as no changes", () => {
  expect(parseNameStatus("")).toEqual([])
})
