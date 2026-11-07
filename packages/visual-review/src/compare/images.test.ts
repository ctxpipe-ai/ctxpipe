import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@blazediff/codec-png-native"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { diff, writeStoryImages } from "../index.ts"
import { screenshot } from "./fixtures.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visual-images-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function png(path: string) {
  return decode(await readFile(path))
}

function pixel(image: ReturnType<typeof decode>, x: number, y: number) {
  return [
    ...image.data.subarray(
      (y * image.width + x) * 4,
      (y * image.width + x) * 4 + 4,
    ),
  ]
}

describe("writeStoryImages", () => {
  test("a changed story gets regions, locator, before, after and diff images", async () => {
    const before = screenshot(800, 600, [
      { box: { x: 600, y: 500, width: 60, height: 24 }, color: [37, 99, 235] },
      { box: { x: 40, y: 40, width: 200, height: 100 }, color: [17, 17, 17] },
    ])
    const after = screenshot(800, 600, [
      { box: { x: 600, y: 500, width: 60, height: 24 }, color: [220, 38, 38] },
    ])
    const comparison = await diff(before, after)
    if (comparison.status !== "changed") throw new Error(comparison.status)

    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      comparison,
    )

    expect(written.omittedRegions).toBe(0)
    expect(written.images).toEqual({
      regions: "story/regions.png",
      locator: "story/locator.png",
      before: "story/before.png",
      after: "story/after.png",
      diff: "story/diff.png",
    })
    expect(await readFile(join(root, "story", "before.png"))).toEqual(
      Buffer.from(before),
    )
    expect(await readFile(join(root, "story", "after.png"))).toEqual(
      Buffer.from(after),
    )
    expect((await png(join(root, "story", "diff.png"))).width).toBe(800)

    // One [before | after] row for each region, largest region first, at
    // native resolution.
    const [large, small] = comparison.regions
    if (!large || !small) throw new Error("expected two regions")
    const tiles = await png(join(root, "story", "regions.png"))
    expect(tiles.width).toBeGreaterThanOrEqual(2 * large.box.width)
    expect(tiles.height).toBeGreaterThanOrEqual(
      large.box.height + small.box.height,
    )
    // The first row shows the removed dark block on the left (before) and
    // white on the right (after).
    const rowMiddle = Math.floor(tiles.height / 4)
    expect(pixel(tiles, Math.floor(tiles.width / 4), rowMiddle)).toEqual([
      17, 17, 17, 255,
    ])
    expect(pixel(tiles, Math.floor((tiles.width * 3) / 4), rowMiddle)).toEqual([
      255, 255, 255, 255,
    ])

    // An overview of about 400 px with each region outlined in red.
    const locator = await png(join(root, "story", "locator.png"))
    expect(locator.width).toBe(400)
    expect(locator.height).toBe(300)
    const box = small.box
    expect(
      pixel(
        locator,
        Math.floor(box.x / 2),
        Math.floor((box.y + box.height / 2) / 2),
      ),
    ).toEqual([255, 0, 0, 255])
  })

  test("a size-changed story gets only the before and after images", async () => {
    const before = screenshot(100, 100, [])
    const after = screenshot(100, 120, [])
    const comparison = await diff(before, after)

    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      comparison,
    )

    expect(written).toEqual({
      images: {
        before: "story/before.png",
        after: "story/after.png",
      },
      omittedRegions: 0,
    })
    expect((await readdir(join(root, "story"))).sort()).toEqual([
      "after.png",
      "before.png",
    ])
  })

  test("an unchanged story gets no images", async () => {
    const image = screenshot(100, 100, [])
    const comparison = await diff(image, image)

    expect(
      await writeStoryImages({ root, dir: "story" }, image, image, comparison),
    ).toEqual({
      images: {},
      omittedRegions: 0,
    })
    expect(await readdir(root)).toEqual([])
  })

  test("regions.png has at most 8 rows; the other regions are counted as omitted", async () => {
    const blocks = Array.from({ length: 30 }, (_, i) => ({
      box: {
        x: 20 + (i % 6) * 60,
        y: 20 + Math.floor(i / 6) * 60,
        width: 20,
        height: 20,
      },
      color: [17, 17, 17] as const,
    }))
    const before = screenshot(400, 340, [])
    const after = screenshot(400, 340, blocks)
    const comparison = await diff(before, after)
    if (comparison.status !== "changed") throw new Error(comparison.status)
    expect(comparison.regions).toHaveLength(30)

    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      comparison,
    )

    expect(written.omittedRegions).toBe(22)
    const [first] = comparison.regions
    if (!first) throw new Error("no region")
    const tiles = await png(join(root, "story", "regions.png"))
    expect(tiles.height).toBeLessThan(9 * (first.box.height + 2 * 8 + 4))
  })

  test("regions.png stops before it is more than 1568 px high", async () => {
    const columns = [0, 1, 2].map((i) => ({
      box: { x: 40 + i * 120, y: 20, width: 40, height: 600 },
      color: [17, 17, 17] as const,
    }))
    const before = screenshot(400, 700, [])
    const after = screenshot(400, 700, columns)
    const comparison = await diff(before, after)
    if (comparison.status !== "changed") throw new Error(comparison.status)
    expect(comparison.regions).toHaveLength(3)

    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      comparison,
    )

    expect(written.omittedRegions).toBe(1)
    const tiles = await png(join(root, "story", "regions.png"))
    expect(tiles.height).toBeLessThanOrEqual(1568)
  })

  test("a region taller than 1568 px gets no row; it is counted as omitted", async () => {
    const before = screenshot(200, 1700, [])
    const after = screenshot(200, 1700, [
      { box: { x: 40, y: 20, width: 40, height: 1660 }, color: [17, 17, 17] },
    ])
    const comparison = await diff(before, after)
    if (comparison.status !== "changed") throw new Error(comparison.status)
    expect(comparison.regions).toHaveLength(1)

    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      comparison,
    )

    expect(written.omittedRegions).toBe(1)
    expect(written.images.regions).toBeUndefined()
    expect(written.images.locator).toBe("story/locator.png")
  })
})
