import { decode, type Image } from "@blazediff/codec-png-native"
import { diff as pixelDiff } from "@blazediff/core-native"

import {
  changeTypes,
  positions,
  type ChangeType,
  type Position,
} from "../story.ts"

/** A box in pixels of the after image. */
export type PixelBox = { x: number; y: number; width: number; height: number }

/** One changed region in pixels. `pixels` counts the changed pixels in it. */
export type MeasuredRegion = {
  box: PixelBox
  changeType: ChangeType | null
  position: Position
  confidence: number
  pixels: number
}

export type Severity = "none" | "low" | "medium" | "high"

type Size = { width: number; height: number }

/**
 * The result of one comparison.
 * - `unchanged`: at most `maxDiffPixels` pixels differ. No regions.
 * - `changed`: more pixels differ. The regions come largest first.
 * - `size-changed`: the images have different sizes, so no pixel diff.
 */
export type Comparison =
  | {
      status: "unchanged" | "changed"
      size: Size
      diffPixels: number
      regions: MeasuredRegion[]
      severity: Severity
      summary: string
      /** Change types, positions and sizes of the regions, to group stories. */
      signature: string
      /** What labeled the regions. Null when the story is unchanged. */
      labeler: "interpreter" | "fallback" | null
      /** The changed pixels in red on a faded copy of the before image. */
      diffImage: Image
    }
  | { status: "size-changed"; before: Size; after: Size; summary: string }

// The pixelmatch color threshold. Lower is stricter.
const threshold = 0.1
// The most fallback components that the merge step accepts.
const maxComponents = 500
const red = [255, 0, 0] as const

/**
 * Compare two PNG screenshots of a story. The pixel diff is
 * `@blazediff/core-native`. For a changed story, `@blazediff/interpret-native`
 * labels the regions. If the interpreter fails, plain connected components
 * of the diff pixels are the regions, with no label.
 */
export async function diff(
  before: Uint8Array,
  after: Uint8Array,
  { maxDiffPixels = 10 }: { maxDiffPixels?: number } = {},
): Promise<Comparison> {
  const a = decode(before)
  const b = decode(after)
  if (a.width !== b.width || a.height !== b.height) {
    const sizes = { before: size(a), after: size(b) }
    return {
      status: "size-changed",
      ...sizes,
      summary: `The image size changed from ${sizes.before.width} × ${sizes.before.height} to ${sizes.after.width} × ${sizes.after.height}.`,
    }
  }

  const diffImage = {
    data: new Uint8Array(a.data.length),
    width: a.width,
    height: a.height,
  }
  const result = await pixelDiff(a, b, {
    threshold,
    antialiasing: true,
    output: diffImage,
    render: { diffColor: [...red] },
  })
  if (result.kind !== "compared") {
    throw new Error(`BlazeDiff could not compare the images: ${result.kind}`)
  }
  const diffPixels = result.count

  if (diffPixels <= maxDiffPixels) {
    return {
      status: "unchanged",
      size: size(b),
      diffPixels,
      regions: [],
      severity: "none",
      summary:
        diffPixels === 0
          ? "No change."
          : `${diffPixels} pixels changed, not more than the tolerance of ${maxDiffPixels}.`,
      signature: "",
      labeler: null,
      diffImage,
    }
  }

  const labeled =
    (await interpreted(before, after)) ?? fallback(diffImage, diffPixels)
  const regions = labeled.regions.sort(
    (x, y) => y.box.width * y.box.height - x.box.width * x.box.height,
  )
  return {
    status: "changed",
    size: size(b),
    diffPixels,
    ...labeled,
    regions,
    signature: regions
      .map(
        ({ box, changeType, position }) =>
          `${changeType ?? "unlabeled"}@${position}:${box.width}x${box.height}`,
      )
      .sort()
      .join(","),
    diffImage,
  }
}

type Labeled = {
  regions: MeasuredRegion[]
  severity: Severity
  summary: string
  labeler: "interpreter" | "fallback"
}

async function interpreted(
  before: Uint8Array,
  after: Uint8Array,
): Promise<Labeled | null> {
  try {
    // A dynamic import, so that a missing binding also goes to the fallback.
    const { interpret } = await import("@blazediff/interpret-native")
    const result = await interpret(before, after, undefined, {
      threshold,
      antialiasing: true,
    })
    return {
      regions: result.regions.map((region) => ({
        box: region.bbox,
        changeType: oneOf(changeTypes, region.changeType),
        position: oneOf(positions, region.position) ?? "center",
        confidence: region.confidence,
        pixels: region.pixelCount,
      })),
      severity: oneOf(["low", "medium", "high"], result.severity) ?? "low",
      summary: result.summary,
      labeler: "interpreter",
    }
  } catch {
    return null
  }
}

function fallback(diffImage: Image, diffPixels: number): Labeled {
  const { width, height } = diffImage
  const regions = components(diffImage).map(({ box, pixels }) => ({
    box,
    changeType: null,
    position: gridCell(box, width, height),
    confidence: 0,
    pixels,
  }))
  const percent = (100 * diffPixels) / (width * height)
  return {
    regions,
    severity: percent < 1 ? "low" : percent <= 10 ? "medium" : "high",
    summary: `${regions.length} changed regions, ${percent.toFixed(2)}% of the image. The interpreter was not available, so the regions have no labels.`,
    labeler: "fallback",
  }
}

/**
 * The 8-connected components of the red diff pixels. Boxes that overlap or
 * are within 12 px across or 8 px down are merged, as the interpreter does.
 * When there are more than 500 components, it keeps the 500 largest and
 * merges none.
 */
function components(image: Image): { box: PixelBox; pixels: number }[] {
  const { data, width, height } = image
  const changed = new Uint8Array(width * height)
  for (let i = 0; i < changed.length; i++) {
    changed[i] = Number(
      data[i * 4] === red[0] &&
        data[i * 4 + 1] === red[1] &&
        data[i * 4 + 2] === red[2],
    )
  }

  const found: { box: PixelBox; pixels: number }[] = []
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start]) continue
    changed[start] = 0
    const stack = [start]
    let [x0, y0, x1, y1, pixels] = [width, height, 0, 0, 0]
    for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
      const x = i % width
      const y = (i - x) / width
      pixels++
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          const n = ny * width + nx
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !changed[n])
            continue
          changed[n] = 0
          stack.push(n)
        }
      }
    }
    found.push({
      box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
      pixels,
    })
  }

  // Too many components is noise. Merging them all is slow, so keep the
  // largest ones as they are.
  if (found.length > maxComponents) {
    return found.sort((p, q) => q.pixels - p.pixels).slice(0, maxComponents)
  }
  for (let merged = true; merged;) {
    merged = false
    for (let i = 0; i < found.length && !merged; i++) {
      for (let j = i + 1; j < found.length && !merged; j++) {
        const p = found[i]
        const q = found[j]
        if (p && q && near(p.box, q.box)) {
          found[i] = { box: union(p.box, q.box), pixels: p.pixels + q.pixels }
          found.splice(j, 1)
          merged = true
        }
      }
    }
  }
  return found
}

function near(p: PixelBox, q: PixelBox): boolean {
  return (
    p.x <= q.x + q.width + 12 &&
    q.x <= p.x + p.width + 12 &&
    p.y <= q.y + q.height + 8 &&
    q.y <= p.y + p.height + 8
  )
}

function union(p: PixelBox, q: PixelBox): PixelBox {
  const x = Math.min(p.x, q.x)
  const y = Math.min(p.y, q.y)
  return {
    x,
    y,
    width: Math.max(p.x + p.width, q.x + q.width) - x,
    height: Math.max(p.y + p.height, q.y + q.height) - y,
  }
}

function gridCell(box: PixelBox, width: number, height: number): Position {
  const column = Math.min(2, Math.floor((3 * (box.x + box.width / 2)) / width))
  const row = Math.min(2, Math.floor((3 * (box.y + box.height / 2)) / height))
  return positions[row * 3 + column] ?? "center"
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string,
): T | null {
  return values.includes(value as T) ? (value as T) : null
}

function size({ width, height }: Size): Size {
  return { width, height }
}
