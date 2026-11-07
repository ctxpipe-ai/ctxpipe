import { describe, expect, test, vi } from "vitest"

import { diff } from "../index.ts"
import { screenshot } from "./fixtures.ts"

// The interpreter is an outside native binding. Make it fail, as it does
// when its binary is missing for the platform.
vi.mock("@blazediff/interpret-native", () => ({
  interpret: () => Promise.reject(new Error("native binding not found")),
}))

describe("diff when the interpreter fails", () => {
  test("it finds plain connected-component regions with no label", async () => {
    const button = { x: 120, y: 80, width: 60, height: 24 }
    const card = { x: 10, y: 10, width: 40, height: 30 }
    const before = screenshot(200, 120, [{ box: button, color: [37, 99, 235] }])
    const after = screenshot(200, 120, [
      { box: button, color: [220, 38, 38] },
      { box: card, color: [17, 17, 17] },
    ])

    const result = await diff(before, after)

    if (result.status !== "changed") throw new Error(result.status)
    expect(result.labeler).toBe("fallback")
    expect(result.diffPixels).toBe(60 * 24 + 40 * 30)
    expect(result.regions).toEqual([
      {
        box: button,
        changeType: null,
        position: "bottom-right",
        confidence: 0,
        pixels: 60 * 24,
      },
      {
        box: card,
        changeType: null,
        position: "top-left",
        confidence: 0,
        pixels: 40 * 30,
      },
    ])
    expect(result.severity).toBe("high")
    expect(result.summary).toMatch(/interpreter/i)
    expect(result.signature).toBe(
      "unlabeled@bottom-right:60x24,unlabeled@top-left:40x30",
    )
  })

  test("it keeps the 500 largest components, with no merge, when there are more", async () => {
    const dots = Array.from({ length: 600 }, (_, i) => ({
      box: { x: (i % 30) * 4, y: Math.floor(i / 30) * 4, width: 1, height: 1 },
      color: [0, 0, 0] as const,
    }))
    dots[0] = { box: { x: 0, y: 0, width: 2, height: 2 }, color: [0, 0, 0] }
    const before = screenshot(120, 80, [])
    const after = screenshot(120, 80, dots)

    const result = await diff(before, after)

    if (result.status !== "changed") throw new Error(result.status)
    expect(result.regions).toHaveLength(500)
    expect(result.regions[0]).toMatchObject({
      box: { x: 0, y: 0, width: 2, height: 2 },
      pixels: 4,
    })
  })
})
