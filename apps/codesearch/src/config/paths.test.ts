import { describe, expect, it } from "vitest"
import { zoektHotDirFromIndexDir } from "./paths.js"

describe("zoektHotDirFromIndexDir", () => {
  it("derives a sibling zoekt-hot directory from the cold index path", () => {
    expect(zoektHotDirFromIndexDir("/data/zoekt-index")).toBe("/data/zoekt-hot")
    expect(zoektHotDirFromIndexDir("/var/lib/ctxpipe/zoekt-index")).toBe(
      "/var/lib/ctxpipe/zoekt-hot",
    )
  })

  it("does not invent a new env-driven path — only dirname + zoekt-hot", () => {
    expect(zoektHotDirFromIndexDir("/tmp/worktree/.data/zoekt-index")).toBe(
      "/tmp/worktree/.data/zoekt-hot",
    )
  })
})
