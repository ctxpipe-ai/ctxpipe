import { expect, it } from "vitest"
import { sandboxSnapshotKey } from "./revision.js"

it("keys the sandbox snapshot by URL plus SHA, not a branch name", () => {
  expect(sandboxSnapshotKey("https://github.com/acme/docs", "abc")).toBe(
    "https://github.com/acme/docs@abc",
  )
  expect(sandboxSnapshotKey("https://github.com/acme/docs", null)).toBeNull()
})
