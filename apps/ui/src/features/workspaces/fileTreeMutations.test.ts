import { describe, expect, it } from "vitest"
import {
  destinationAfterMove,
  isMoveIntoSelf,
  joinFileName,
  optimisticPathsAfterJob,
  parentDirectory,
} from "./fileTreeMutations"

describe("file tree mutations", () => {
  it("joins a name under a directory", () => {
    expect(joinFileName("knowledge", "notes.md")).toBe("knowledge/notes.md")
    expect(joinFileName(null, "AGENTS.md")).toBe("AGENTS.md")
    expect(joinFileName("knowledge", "../secret")).toBeNull()
    expect(parentDirectory("knowledge/billing/ledger.md")).toBe(
      "knowledge/billing",
    )
    expect(destinationAfterMove("AGENTS.md", "knowledge")).toBe(
      "knowledge/AGENTS.md",
    )
  })

  it("refuses moving a folder into itself", () => {
    expect(isMoveIntoSelf("knowledge/billing", "knowledge/billing")).toBe(true)
    expect(
      isMoveIntoSelf("knowledge/billing", "knowledge/billing/nested"),
    ).toBe(true)
    expect(isMoveIntoSelf("knowledge/billing", "knowledge")).toBe(false)
  })

  it("updates paths after create, rename, move, and delete", () => {
    const paths = ["AGENTS.md", "knowledge/billing/ledger.md"]
    expect(
      optimisticPathsAfterJob(paths, { op: "create", path: "notes.md" }),
    ).toEqual(["AGENTS.md", "knowledge/billing/ledger.md", "notes.md"])
    expect(
      optimisticPathsAfterJob(paths, {
        op: "rename",
        from: "AGENTS.md",
        to: "GUIDE.md",
      }),
    ).toEqual(["GUIDE.md", "knowledge/billing/ledger.md"])
    expect(
      optimisticPathsAfterJob(paths, {
        op: "move",
        from: "AGENTS.md",
        toDirectory: "knowledge",
      }),
    ).toEqual(["knowledge/AGENTS.md", "knowledge/billing/ledger.md"])
    expect(
      optimisticPathsAfterJob(paths, {
        op: "delete",
        path: "knowledge/billing",
      }),
    ).toEqual(["AGENTS.md"])
  })
})
