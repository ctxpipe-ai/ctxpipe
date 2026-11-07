import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { decode, encode, type Image } from "@blazediff/codec-png-native"

import type { StoryImage } from "../story.ts"
import type { Comparison, PixelBox } from "./diff.ts"

/** The image files of one story, by role. A role is absent when not written. */
export type StoryImages = Partial<Record<StoryImage["role"], string>>

// Pixels of context around each region crop, and of gray between the tiles.
const margin = 8
const gap = 4
const gray = [128, 128, 128, 255] as const
const red = [255, 0, 0, 255] as const

/**
 * Write the images of one compared story into `dir`:
 * - a changed story gets `regions.png`, `locator.png`, `before.png`,
 *   `after.png` and `diff.png`;
 * - a size-changed story gets only `before.png` and `after.png`;
 * - an unchanged story gets no images.
 * `before` and `after` are the PNG bytes that went to `diff`.
 */
export async function writeStoryImages(
  dir: string,
  before: Uint8Array,
  after: Uint8Array,
  comparison: Comparison,
): Promise<StoryImages> {
  if (comparison.status === "unchanged") return {}
  await mkdir(dir, { recursive: true })
  const write = async (name: string, png: Uint8Array) => {
    const path = join(dir, name)
    await writeFile(path, png)
    return path
  }

  if (comparison.status === "size-changed") {
    return {
      before: await write("before.png", before),
      after: await write("after.png", after),
    }
  }

  const a = decode(before)
  const b = decode(after)
  return {
    regions: await write(
      "regions.png",
      encode(
        regionTiles(
          a,
          b,
          comparison.regions.map(({ box }) => box),
        ),
      ),
    ),
    locator: await write(
      "locator.png",
      encode(
        locator(
          b,
          comparison.regions.map(({ box }) => box),
        ),
      ),
    ),
    before: await write("before.png", before),
    after: await write("after.png", after),
    diff: await write("diff.png", encode(comparison.diffImage)),
  }
}

/**
 * One [before | after] row for each box, in the order of the boxes, at native
 * resolution. Gray fills the space between and beside the tiles.
 */
function regionTiles(a: Image, b: Image, boxes: readonly PixelBox[]): Image {
  const crops = boxes.map((box) => grow(box, margin, a))
  const width = Math.max(1, ...crops.map((crop) => 2 * crop.width + gap))
  const height = Math.max(
    1,
    crops.reduce((sum, crop) => sum + crop.height, 0) +
      gap * Math.max(0, crops.length - 1),
  )
  const out = filled(width, height, gray)
  let top = 0
  for (const crop of crops) {
    copy(a, crop, out, 0, top)
    copy(b, crop, out, crop.width + gap, top)
    top += crop.height + gap
  }
  return out
}

/**
 * The after image scaled so that its long side is 400 px (never up), with
 * each box outlined in red, 2 px wide.
 */
function locator(image: Image, boxes: readonly PixelBox[]): Image {
  const scale = Math.min(1, 400 / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const out = filled(width, height, gray)
  // Each output pixel is the mean of the source pixels that it covers.
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y / scale)
    const y1 = Math.max(
      y0 + 1,
      Math.min(image.height, Math.floor((y + 1) / scale)),
    )
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x / scale)
      const x1 = Math.max(
        x0 + 1,
        Math.min(image.width, Math.floor((x + 1) / scale)),
      )
      let [r, g, b, a] = [0, 0, 0, 0]
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4
          r += image.data[i] ?? 0
          g += image.data[i + 1] ?? 0
          b += image.data[i + 2] ?? 0
          a += image.data[i + 3] ?? 0
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      out.data.set(
        [r, g, b, a].map((value) => Math.round(value / count)),
        (y * width + x) * 4,
      )
    }
  }
  for (const box of boxes) {
    const x0 = Math.floor(box.x * scale)
    const y0 = Math.floor(box.y * scale)
    const x1 = Math.min(width - 1, Math.ceil((box.x + box.width) * scale) - 1)
    const y1 = Math.min(height - 1, Math.ceil((box.y + box.height) * scale) - 1)
    for (let t = 0; t < 2; t++) {
      for (let x = x0; x <= x1; x++) {
        paint(out, x, y0 + t)
        paint(out, x, y1 - t)
      }
      for (let y = y0; y <= y1; y++) {
        paint(out, x0 + t, y)
        paint(out, x1 - t, y)
      }
    }
  }
  return out
}

function paint(image: Image, x: number, y: number) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  image.data.set(red, (y * image.width + x) * 4)
}

function grow(box: PixelBox, by: number, image: Image): PixelBox {
  const x = Math.max(0, box.x - by)
  const y = Math.max(0, box.y - by)
  return {
    x,
    y,
    width: Math.min(image.width, box.x + box.width + by) - x,
    height: Math.min(image.height, box.y + box.height + by) - y,
  }
}

function filled(
  width: number,
  height: number,
  color: readonly number[],
): Image {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(color, i)
  return { data, width, height }
}

function copy(
  from: Image,
  box: PixelBox,
  to: Image,
  left: number,
  top: number,
) {
  for (let y = 0; y < box.height; y++) {
    const start = ((box.y + y) * from.width + box.x) * 4
    to.data.set(
      from.data.subarray(start, start + box.width * 4),
      ((top + y) * to.width + left) * 4,
    )
  }
}
