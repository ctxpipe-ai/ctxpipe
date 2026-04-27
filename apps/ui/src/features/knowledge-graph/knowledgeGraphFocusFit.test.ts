import { describe, expect, it } from "vitest"
import {
  buildFocusFitTarget,
  chooseRobustFocusFitIndices,
} from "./knowledgeGraphFocusFit"

describe("chooseRobustFocusFitIndices", () => {
  it("keeps small focus sets intact", () => {
    const indices = [1, 2, 3, 4]
    const result = chooseRobustFocusFitIndices(indices, (index) => [index, 0])

    expect(result).toEqual(indices)
  })

  it("keeps most nodes instead of collapsing to a tiny dense cluster", () => {
    const indices = Array.from({ length: 24 }, (_, index) => index)
    const result = chooseRobustFocusFitIndices(indices, (index) => [index, 0])

    expect(result).toHaveLength(18)
    expect(result).toEqual(Array.from({ length: 18 }, (_, index) => index + 3))
  })

  it("trims distant positional outliers", () => {
    const indices = Array.from({ length: 24 }, (_, index) => index)
    const result = chooseRobustFocusFitIndices(indices, (index) =>
      index >= 20 ? [1000 + index, 1000 + index] : [index, index % 3],
    )

    expect(result).toHaveLength(18)
    expect(result).not.toContain(20)
    expect(result).not.toContain(21)
    expect(result).not.toContain(22)
    expect(result).not.toContain(23)
  })

  it("falls back to the minimum useful set when positions are unavailable", () => {
    const indices = Array.from({ length: 24 }, (_, index) => index)
    const result = chooseRobustFocusFitIndices(indices, () => undefined)

    expect(result).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })

  it("builds coordinates for the selected fit indices", () => {
    const result = buildFocusFitTarget([2, 4], (index) => [index, index * 10])

    expect(result.indices).toEqual([2, 4])
    expect(result.coordinates).toEqual([2, 20, 4, 40])
  })

  it("keeps the index fallback available when coordinates are missing", () => {
    const result = buildFocusFitTarget([2, 4], () => undefined)

    expect(result.indices).toEqual([2, 4])
    expect(result.coordinates).toEqual([])
  })

  it("uses the robust strategy before producing fit coordinates", () => {
    const indices = Array.from({ length: 24 }, (_, index) => index)
    const result = buildFocusFitTarget(
      indices,
      (index) =>
        index >= 20 ? [1000 + index, 1000 + index] : [index, index % 3],
      { strategy: "robust" },
    )

    expect(result.indices).toHaveLength(18)
    expect(result.indices).not.toContain(20)
    expect(result.indices).not.toContain(21)
    expect(result.coordinates).toHaveLength(36)
  })
})
