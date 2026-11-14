import { readFileSync } from "node:fs"

import { describe, expect, test } from "vitest"

import { diff } from "../index.ts"
import { contains, screenshot } from "./fixtures.ts"

const button = { x: 120, y: 80, width: 60, height: 24 }
const heading = { x: 20, y: 10, width: 100, height: 16 }
const blue = [37, 99, 235] as const
const red = [220, 38, 38] as const
const black = [17, 17, 17] as const

const before = screenshot(200, 120, [
  { box: heading, color: black },
  { box: button, color: blue },
])

describe("diff", () => {
  test("a changed button color is a changed story with a color-change region over the button", async () => {
    const after = screenshot(200, 120, [
      { box: heading, color: black },
      { box: button, color: red },
    ])

    const result = await diff(before, after)

    expect(result.status).toBe("changed")
    if (result.status !== "changed") return
    expect(result.diffPixels).toBe(button.width * button.height)
    expect(result.regions).toHaveLength(1)
    const [region] = result.regions
    expect(region?.changeType).toBe("color-change")
    expect(region?.position).toBe("bottom-right")
    expect(region?.stats?.shape).toBe("solid-region")
    expect(region?.stats?.colorDelta.meanDelta).toBeGreaterThan(0)
    expect(region && contains(region.box, button)).toBe(true)
    expect(region && contains(region.box, heading)).toBe(false)
    expect(result.severity).not.toBe("none")
    expect(result.summary).toMatch(/color/i)
    expect(result.signature).toMatch(/^color-change@bottom-right:\d+x\d+$/)
  })

  test("identical images are an unchanged story with no regions", async () => {
    const result = await diff(before, before)

    expect(result).toMatchObject({
      status: "unchanged",
      diffPixels: 0,
      regions: [],
      severity: "none",
    })
  })

  test("a change of at most maxDiffPixels pixels is unchanged", async () => {
    const dot = { x: 5, y: 100, width: 2, height: 5 }
    const after = screenshot(200, 120, [
      { box: heading, color: black },
      { box: button, color: blue },
      { box: dot, color: black },
    ])

    expect(await diff(before, after)).toMatchObject({
      status: "unchanged",
      diffPixels: 10,
    })
    expect(await diff(before, after, { maxDiffPixels: 9 })).toMatchObject({
      status: "changed",
      diffPixels: 10,
    })
  })

  test("a faint color change over a large area is a changed story", async () => {
    // Two captures of one story: the Card surface changed from rgb(10,10,10)
    // to about rgb(18,18,21). Each pixel is below `threshold`.
    const fixture = (name: string) =>
      readFileSync(
        new URL(`./fixtures/card-surface.${name}.png`, import.meta.url),
      )
    const card = { x: 528, y: 116, width: 608, height: 64 }

    const result = await diff(fixture("before"), fixture("after"))

    if (result.status !== "changed") throw new Error(result.summary)
    expect(result.diffPixels).toBeGreaterThan(100_000)
    expect(result.regions.some(({ box }) => contains(box, card))).toBe(true)
    expect(result.summary).toMatch(/faint/i)
  })

  test("a faint color change in small or thin parts only is unchanged", async () => {
    // A text-sized box and a line 1 px high across the image, 6 levels of
    // gray darker: below `threshold`, and smaller than one full area.
    const near = [249, 249, 249] as const
    const page = screenshot(200, 120, [])
    const after = screenshot(200, 120, [
      { box: { x: 10, y: 10, width: 20, height: 20 }, color: near },
      { box: { x: 0, y: 60, width: 200, height: 1 }, color: near },
    ])

    expect(await diff(page, after)).toMatchObject({ status: "unchanged" })
  })

  test("images of different sizes are a size-changed story", async () => {
    const taller = screenshot(200, 140, [{ box: button, color: blue }])

    expect(await diff(before, taller)).toMatchObject({
      status: "size-changed",
      before: { width: 200, height: 120 },
      after: { width: 200, height: 140 },
    })
  })

  test("regions come largest first", async () => {
    const after = screenshot(200, 120, [
      { box: heading, color: black },
      { box: button, color: blue },
      { box: { x: 10, y: 60, width: 8, height: 8 }, color: red },
      { box: { x: 20, y: 90, width: 60, height: 20 }, color: red },
    ])

    const result = await diff(before, after)

    if (result.status !== "changed") throw new Error(result.status)
    const areas = result.regions.map(({ box }) => box.width * box.height)
    expect(areas.length).toBeGreaterThan(1)
    expect(areas).toEqual([...areas].sort((a, b) => b - a))
  })
})
