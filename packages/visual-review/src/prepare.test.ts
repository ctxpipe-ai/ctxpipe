import { decode } from "@blazediff/codec-png-native"
import { describe, expect, test } from "vitest"

import { screenshot } from "./compare/fixtures.ts"
import { prepareImage } from "./prepare.ts"

const side = (bytes: Uint8Array) => {
  const { width, height } = decode(bytes)
  return { width, height }
}

describe("prepareImage", () => {
  test("a 100 px crop is padded to 280 px, with the crop at the top left", () => {
    const crop = screenshot(100, 100, [
      { box: { x: 0, y: 0, width: 100, height: 100 }, color: [220, 38, 38] },
    ])

    const { png, content } = prepareImage(crop)

    const prepared = decode(png)
    expect(prepared.width).toBe(280)
    expect(prepared.height).toBe(280)
    const at = (x: number, y: number) => [
      ...prepared.data.subarray((y * 280 + x) * 4, (y * 280 + x) * 4 + 4),
    ]
    expect(at(99, 99)).toEqual([220, 38, 38, 255])
    expect(at(100, 50)).toEqual([128, 128, 128, 255])
    expect(at(50, 279)).toEqual([128, 128, 128, 255])
    expect(content.width).toBeCloseTo(100 / 280)
    expect(content.height).toBeCloseTo(100 / 280)
  })

  test("a 3000 px wide image is scaled down to 1568 px, with its aspect ratio", () => {
    const { png, content } = prepareImage(screenshot(3000, 600, []))

    expect(side(png)).toEqual({ width: 1568, height: 314 })
    expect(content).toEqual({ width: 1, height: 1 })
  })

  test("a tall image is scaled down to 1568 px high, with its aspect ratio", () => {
    expect(side(prepareImage(screenshot(1000, 3136, [])).png)).toEqual({
      width: 500,
      height: 1568,
    })
  })

  test("a very wide strip is scaled down, then padded in height", () => {
    const { png, content } = prepareImage(screenshot(3000, 100, []))

    expect(side(png)).toEqual({ width: 1568, height: 280 })
    // The strip is 1568 x 52 px after scaling, at the top of 280 px.
    expect(content.width).toBe(1)
    expect(content.height).toBeCloseTo(52 / 280)
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

    const scaled = decode(prepareImage(stripes).png)

    expect(scaled.width).toBe(1568)
    expect(scaled.data[0]).toBeGreaterThanOrEqual(127)
    expect(scaled.data[0]).toBeLessThanOrEqual(128)
  })

  test("an image within the limits is returned as it is", () => {
    const fine = screenshot(400, 300, [])

    expect(prepareImage(fine)).toEqual({
      png: fine,
      content: { width: 1, height: 1 },
    })
    expect(prepareImage(fine).png).toBe(fine)
  })

  test("bytes that are not a PNG are returned as they are", () => {
    const text = Buffer.from("not a png")

    expect(prepareImage(text).png).toBe(text)
  })
})
