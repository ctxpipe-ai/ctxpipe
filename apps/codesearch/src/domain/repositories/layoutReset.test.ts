import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCacheForLayout } from "./layoutReset.js"

let root: string
let cache: string
let index: string
let outside: string
let marker: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codesearch-layout-"))
  cache = join(root, "repo-cache")
  index = join(root, "zoekt-index")
  outside = join(root, "outside")
  marker = join(cache, ".codesearch-layout")
  for (const dir of [cache, index, outside]) mkdirSync(dir)
  mkdirSync(join(cache, "org_a", "repo_a", "checkouts", "ws:ws_one"), {
    recursive: true,
  })
  writeFileSync(join(index, "repo_a_v16.00000.zoekt"), "shard")
  writeFileSync(join(outside, "keep.txt"), "keep")
  // A symlink to a file outside: the reset deletes the link, not its target.
  symlinkSync(join(outside, "keep.txt"), join(index, "link.zoekt"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("resetCacheForLayout", () => {
  it("empties only the two directories once, then writes the layout file", async () => {
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: [cache, index] }),
    ).resolves.toEqual({ reset: true })

    expect(readdirSync(cache)).toEqual([".codesearch-layout"])
    expect(readdirSync(index)).toEqual([])
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep")
    expect(readFileSync(marker, "utf8").trim()).toBe("2")

    // A later start keeps what the new layout wrote.
    mkdirSync(join(cache, "org_a"))
    writeFileSync(join(index, "repo_a_v16.00000.zoekt"), "new shard")
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: [cache, index] }),
    ).resolves.toEqual({ reset: false })
    expect(existsSync(join(cache, "org_a"))).toBe(true)
    expect(existsSync(join(index, "repo_a_v16.00000.zoekt"))).toBe(true)
  })

  it("empties the directories again when the layout file names an older layout", async () => {
    writeFileSync(marker, "1\n")
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: [cache, index] }),
    ).resolves.toEqual({ reset: true })
    expect(existsSync(join(cache, "org_a"))).toBe(false)
    expect(readFileSync(marker, "utf8").trim()).toBe("2")
  })

  it("refuses a relative or root directory and deletes nothing", async () => {
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: ["/"] }),
    ).rejects.toThrow("absolute non-root")
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: ["repo-cache"] }),
    ).rejects.toThrow("absolute non-root")
    expect(existsSync(join(cache, "org_a"))).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it("refuses a directory inside the other and deletes nothing", async () => {
    const nested = join(cache, "zoekt-index")
    mkdirSync(nested)
    writeFileSync(join(nested, "a.zoekt"), "shard")
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: [cache, nested] }),
    ).rejects.toThrow("separate paths")
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: [nested, cache] }),
    ).rejects.toThrow("separate paths")
    expect(existsSync(join(nested, "a.zoekt"))).toBe(true)
    expect(existsSync(join(cache, "org_a"))).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it("accepts the same directory twice", async () => {
    await expect(
      resetCacheForLayout({ markerPath: marker, dirs: [cache, cache] }),
    ).resolves.toEqual({ reset: true })
    expect(readdirSync(cache)).toEqual([".codesearch-layout"])
  })
})
