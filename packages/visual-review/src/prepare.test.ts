import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { decode } from "@blazediff/codec-png-native"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { screenshot } from "./compare/fixtures.ts"
import { diff, prepareImage, prepareImages, writeStoryImages } from "./index.ts"
import type { StoryInput } from "./story.ts"

const side = (bytes: Uint8Array) => {
  const { width, height } = decode(bytes)
  return { width, height }
}

describe("prepareImage", () => {
  test("a 100 px crop is padded to 280 px, with the crop at the top left", () => {
    const crop = screenshot(100, 100, [
      { box: { x: 0, y: 0, width: 100, height: 100 }, color: [220, 38, 38] },
    ])

    const prepared = decode(prepareImage(crop))

    expect(prepared.width).toBe(280)
    expect(prepared.height).toBe(280)
    const at = (x: number, y: number) => [
      ...prepared.data.subarray((y * 280 + x) * 4, (y * 280 + x) * 4 + 4),
    ]
    expect(at(99, 99)).toEqual([220, 38, 38, 255])
    expect(at(100, 50)).toEqual([128, 128, 128, 255])
    expect(at(50, 279)).toEqual([128, 128, 128, 255])
  })

  test("a 3000 px wide image is scaled down to 1568 px, with its aspect ratio", () => {
    const wide = screenshot(3000, 600, [])

    expect(side(prepareImage(wide))).toEqual({ width: 1568, height: 314 })
  })

  test("a tall image is scaled down to 1568 px high, with its aspect ratio", () => {
    expect(side(prepareImage(screenshot(1000, 3136, [])))).toEqual({
      width: 500,
      height: 1568,
    })
  })

  test("a very wide strip is scaled down, then padded in height", () => {
    expect(side(prepareImage(screenshot(3000, 100, [])))).toEqual({
      width: 1568,
      height: 280,
    })
  })

  test("a scaled image keeps the mean color of the pixels that it covers", () => {
    // Every second column is black, the others are white: the mean is gray.
    const stripes = screenshot(
      3136,
      400,
      Array.from({ length: 1568 }, (_, i) => ({
        box: { x: i * 2, y: 0, width: 1, height: 400 },
        color: [0, 0, 0] as const,
      })),
    )

    const scaled = decode(prepareImage(stripes))

    expect(scaled.width).toBe(1568)
    expect(scaled.data[0]).toBeGreaterThanOrEqual(127)
    expect(scaled.data[0]).toBeLessThanOrEqual(128)
  })

  test("an image within the limits is returned as it is", () => {
    const fine = screenshot(400, 300, [])

    expect(prepareImage(fine)).toBe(fine)
  })
})

describe("prepareImages", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "visual-prepare-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("the regions and locator of a wide page fit the model limits", async () => {
    // A 3000 px wide page with one wide changed region: regions.png is about
    // 3000 px wide, and the locator is 400 x 54 px.
    const before = screenshot(3000, 400, [
      { box: { x: 100, y: 100, width: 1500, height: 60 }, color: [17, 17, 17] },
    ])
    const after = screenshot(3000, 400, [
      {
        box: { x: 100, y: 100, width: 1500, height: 60 },
        color: [220, 38, 38],
      },
    ])
    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      await diff(before, after),
    )
    const input: StoryInput = {
      storyId: "wide--default",
      scope: "page",
      viewport: { width: 3000, height: 400 },
      regions: [],
      images: [
        { role: "regions", path: join(root, written.images.regions ?? "") },
        { role: "locator", path: join(root, written.images.locator ?? "") },
      ],
    }
    expect(
      side(await readFile(input.images[0]?.path ?? "")).width,
    ).toBeGreaterThan(2900)

    const prepared = await prepareImages(input)

    expect(prepared.images.map(({ role }) => role)).toEqual([
      "regions",
      "locator",
    ])
    for (const { path } of prepared.images) {
      const { width, height } = side(await readFile(path))
      expect(width).toBeGreaterThanOrEqual(280)
      expect(width).toBeLessThanOrEqual(1568)
      expect(height).toBeGreaterThanOrEqual(280)
      expect(height).toBeLessThanOrEqual(1568)
    }
  })

  test("an image within the limits keeps its path, and the originals stay as they are", async () => {
    const before = screenshot(800, 600, [])
    const after = screenshot(800, 600, [
      { box: { x: 10, y: 10, width: 100, height: 40 }, color: [220, 38, 38] },
    ])
    const written = await writeStoryImages(
      { root, dir: "story" },
      before,
      after,
      await diff(before, after),
    )
    const afterPath = join(root, written.images.after ?? "")
    const regionsPath = join(root, written.images.regions ?? "")
    const regionsBytes = await readFile(regionsPath)

    const prepared = await prepareImages({
      storyId: "small--default",
      scope: "component",
      viewport: { width: 800, height: 600 },
      regions: [],
      images: [
        { role: "after", path: afterPath },
        { role: "regions", path: regionsPath },
      ],
    })

    expect(prepared.images[0]?.path).toBe(afterPath)
    // The one row is a 116 x 56 crop beside its twin: 236 x 56, too small.
    const small = prepared.images[1]
    expect(small?.path).not.toBe(regionsPath)
    expect(dirname(small?.path ?? "")).toBe(
      join(dirname(regionsPath), "prepared"),
    )
    expect(side(await readFile(small?.path ?? ""))).toEqual({
      width: 280,
      height: 280,
    })
    expect(await readFile(regionsPath)).toEqual(regionsBytes)
  })

  test("a file that is not a PNG is left for the judge to report", async () => {
    const path = join(root, "notes.png")
    await writeFile(path, "not a png")

    const prepared = await prepareImages({
      storyId: "x--y",
      scope: "component",
      viewport: { width: 1440, height: 900 },
      regions: [],
      images: [{ role: "after", path }],
    })

    expect(prepared.images).toEqual([{ role: "after", path }])
  })
})
