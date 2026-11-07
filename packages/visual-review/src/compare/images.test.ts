import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@blazediff/codec-png-native"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { diff, writeStoryImages } from "../index.ts"
import { screenshot } from "./fixtures.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visual-images-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
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

    const images = await writeStoryImages(dir, before, after, comparison)

    expect(images).toEqual({
      regions: join(dir, "regions.png"),
      locator: join(dir, "locator.png"),
      before: join(dir, "before.png"),
      after: join(dir, "after.png"),
      diff: join(dir, "diff.png"),
    })
    expect(await readFile(join(dir, "before.png"))).toEqual(Buffer.from(before))
    expect(await readFile(join(dir, "after.png"))).toEqual(Buffer.from(after))
    expect((await png(join(dir, "diff.png"))).width).toBe(800)

    // One [before | after] row for each region, largest region first, at
    // native resolution.
    const [large, small] = comparison.regions
    if (!large || !small) throw new Error("expected two regions")
    const tiles = await png(join(dir, "regions.png"))
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
    const locator = await png(join(dir, "locator.png"))
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

    const images = await writeStoryImages(dir, before, after, comparison)

    expect(images).toEqual({
      before: join(dir, "before.png"),
      after: join(dir, "after.png"),
    })
    expect((await readdir(dir)).sort()).toEqual(["after.png", "before.png"])
  })

  test("an unchanged story gets no images", async () => {
    const image = screenshot(100, 100, [])
    const comparison = await diff(image, image)

    expect(await writeStoryImages(dir, image, image, comparison)).toEqual({})
    expect(await readdir(dir)).toEqual([])
  })
})
