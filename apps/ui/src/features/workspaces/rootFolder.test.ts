import { describe, expect, it } from "vitest"

import { normalizeRootFolder, rootFolderError } from "./rootFolder"

describe("rootFolder", () => {
  it.each([
    ["", ""],
    ["  docs/context/ ", "docs/context"],
    ["/", ""],
  ])("normalizes %j to %j", (raw, normalized) => {
    expect(normalizeRootFolder(raw)).toBe(normalized)
    expect(rootFolderError(raw)).toBeNull()
  })

  it.each([
    "/docs",
    "../docs",
    "docs/../x",
    "docs//context",
    ".git",
    "docs/.Git",
    "docs\\context",
    "docs/con text",
    "x".repeat(201),
  ])("explains why %j is not a valid folder", (raw) => {
    expect(rootFolderError(raw)).toMatch(/folder/)
  })
})
