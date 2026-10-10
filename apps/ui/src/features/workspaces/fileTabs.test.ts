import { describe, expect, it } from "vitest"
import {
  closeFileTab,
  pinFile,
  previewFile,
  seedFileTabSession,
} from "./fileTabs"

describe("previewFile", () => {
  it("opens the first click as an unlocked preview tab", () => {
    expect(previewFile({ tabs: [], previewPath: null }, "a.ts")).toEqual({
      tabs: ["a.ts"],
      previewPath: "a.ts",
    })
  })

  it("replaces the unlocked preview tab on the next click", () => {
    expect(
      previewFile({ tabs: ["a.ts"], previewPath: "a.ts" }, "b.ts"),
    ).toEqual({
      tabs: ["b.ts"],
      previewPath: "b.ts",
    })
  })

  it("does not replace a pinned tab", () => {
    const pinned = { tabs: ["a.ts"], previewPath: null }
    expect(previewFile(pinned, "a.ts")).toEqual(pinned)
    expect(previewFile(pinned, "b.ts")).toEqual({
      tabs: ["a.ts", "b.ts"],
      previewPath: "b.ts",
    })
  })
})

describe("pinFile", () => {
  it("locks the current preview so the next file opens in a new tab", () => {
    const pinned = pinFile({ tabs: ["a.ts"], previewPath: "a.ts" }, "a.ts")
    expect(pinned).toEqual({ tabs: ["a.ts"], previewPath: null })
    expect(previewFile(pinned, "b.ts")).toEqual({
      tabs: ["a.ts", "b.ts"],
      previewPath: "b.ts",
    })
  })

  it("opens and locks a file that was not in the tab list", () => {
    expect(pinFile({ tabs: [], previewPath: null }, "a.ts")).toEqual({
      tabs: ["a.ts"],
      previewPath: null,
    })
  })
})

describe("seedFileTabSession", () => {
  it("treats a URL-only file as the unlocked preview", () => {
    expect(seedFileTabSession({ tabs: [], previewPath: null }, "a.ts")).toEqual(
      { tabs: ["a.ts"], previewPath: "a.ts" },
    )
  })
})

describe("closeFileTab", () => {
  it("drops the tab and clears preview when it was the unlocked one", () => {
    expect(
      closeFileTab({ tabs: ["a.ts", "b.ts"], previewPath: "b.ts" }, "b.ts"),
    ).toEqual({
      tabs: ["a.ts"],
      previewPath: null,
    })
  })
})
