// The visibility rule of a real change, with the real compare engine on
// small stand-in screenshots.
import { expect, test } from "vitest"

import { diff } from "../../src/compare/diff.ts"
import { screenshot } from "../../src/compare/fixtures.ts"
import { visible } from "./build.ts"

const page = (boxes: Parameters<typeof screenshot>[2]) =>
  screenshot(1440, 900, [
    { box: { x: 40, y: 40, width: 600, height: 40 }, color: [30, 30, 30] },
    ...boxes,
  ])
const teal = [20, 150, 140] as const

test("a change that covers 0.2% of the page is visible; a status dot is not", async () => {
  const before = page([])
  // 120 × 30 = 3,600 pixels: more than 0.2% of 1440 × 900 (2,592).
  const block = await diff(
    before,
    page([{ box: { x: 200, y: 300, width: 120, height: 30 }, color: teal }]),
  )
  // A dot of 12 × 12 pixels.
  const dot = await diff(
    before,
    page([{ box: { x: 200, y: 300, width: 12, height: 12 }, color: teal }]),
  )

  expect(block.status).toBe("changed")
  expect(dot.status).toBe("changed")
  expect(visible(block)).toBe(true)
  expect(visible(dot)).toBe(false)
  expect(visible(await diff(before, before))).toBe(false)
})
