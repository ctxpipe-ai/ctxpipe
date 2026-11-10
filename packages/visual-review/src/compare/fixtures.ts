import { encode } from "@blazediff/codec-png-native"

import type { PixelBox } from "./diff.ts"

type Rgb = readonly [number, number, number]

/**
 * A PNG of a white page with filled boxes on it: a small stand-in for a
 * story screenshot.
 */
export function screenshot(
  width: number,
  height: number,
  boxes: readonly { box: PixelBox; color: Rgb }[],
): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(255)
  for (const { box, color } of boxes) {
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        data.set(color, (y * width + x) * 4)
      }
    }
  }
  return encode({ data, width, height })
}

/** True when `outer` holds all of `inner`. */
export function contains(outer: PixelBox, inner: PixelBox): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  )
}
