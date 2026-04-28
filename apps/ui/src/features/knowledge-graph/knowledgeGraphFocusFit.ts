type PointPosition = readonly [number, number]

type PositionedIndex = {
  index: number
  position: PointPosition
}

type RobustFocusFitOptions = {
  minNodes?: number
  retainedRatio?: number
}

type FocusFitOptions = RobustFocusFitOptions & {
  strategy?: "all" | "robust"
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function interquartileRange(values: number[]): number {
  if (values.length < 4) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)] ?? 0
  const q3 = sorted[Math.floor(sorted.length * 0.75)] ?? q1
  return Math.max(1, q3 - q1)
}

/**
 * Choose a camera-fit subset for KG answer focus. We keep most focused nodes in
 * frame, but trim positional outliers so one far-away match does not make the
 * actual answer unreadably small.
 */
export function chooseRobustFocusFitIndices(
  indices: number[],
  getPosition: (index: number) => PointPosition | undefined,
  options?: RobustFocusFitOptions,
): number[] {
  const minNodes = options?.minNodes ?? 12
  const retainedRatio = options?.retainedRatio ?? 0.75
  if (indices.length <= minNodes) return indices

  const positioned: PositionedIndex[] = []
  for (const index of indices) {
    const position = getPosition(index)
    if (position) positioned.push({ index, position })
  }

  if (positioned.length <= minNodes) {
    return positioned.length > 0
      ? positioned.map((item) => item.index)
      : indices.slice(0, minNodes)
  }

  const targetCount = Math.min(
    positioned.length,
    Math.max(minNodes, Math.ceil(positioned.length * retainedRatio)),
  )
  if (positioned.length <= targetCount) {
    return positioned.map((item) => item.index)
  }

  const xs = positioned.map((item) => item.position[0])
  const ys = positioned.map((item) => item.position[1])
  const centerX = median(xs)
  const centerY = median(ys)
  const scaleX = interquartileRange(xs)
  const scaleY = interquartileRange(ys)

  const selected = new Set(
    positioned
      .map((item) => {
        const dx = (item.position[0] - centerX) / scaleX
        const dy = (item.position[1] - centerY) / scaleY
        return { index: item.index, distance: dx * dx + dy * dy }
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, targetCount)
      .map((item) => item.index),
  )

  return indices.filter((index) => selected.has(index))
}

export function buildFocusFitTarget(
  indices: number[],
  getPosition: (index: number) => PointPosition | undefined,
  options?: FocusFitOptions,
): { coordinates: number[]; indices: number[] } {
  const fitIndices =
    options?.strategy === "robust"
      ? chooseRobustFocusFitIndices(indices, getPosition, options)
      : indices

  const coordinates = fitIndices.flatMap((index) => {
    const position = getPosition(index)
    return position ?? []
  })

  return { coordinates, indices: fitIndices }
}
