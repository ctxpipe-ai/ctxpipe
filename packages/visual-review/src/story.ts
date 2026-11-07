/** A box in fractions (0..1) of the after image. */
export type Box = { x: number; y: number; width: number; height: number }

/** One changed region, as the BlazeDiff interpreter labels it. */
export type Region = {
  box: Box
  changeType:
    | "addition"
    | "deletion"
    | "content-change"
    | "color-change"
    | "shift"
    | "rendering-noise"
  position:
    | "top-left"
    | "top"
    | "top-right"
    | "left"
    | "center"
    | "right"
    | "bottom-left"
    | "bottom"
    | "bottom-right"
  confidence: number
}

/**
 * An image that goes to the judge. The prompt lists the images in this
 * order, and the judge attaches them in the same order.
 * - `regions`: one [before | after] row for each region, at native resolution.
 * - `locator`: an overview of the after image with each region outlined in red.
 * - `before`, `after`, `diff`: the full images, a fallback.
 */
export type StoryImage = {
  role: "regions" | "locator" | "before" | "after" | "diff"
  path: string
}

/** Everything the critic knows about one changed story. */
export type StoryInput = {
  storyId: string
  /** `page` for a story with the `page` tag; else a part of the UI. */
  scope: "page" | "component"
  viewport: { width: number; height: number }
  /** The measured regions. Empty when the image size changed. */
  regions: readonly Region[]
  images: readonly StoryImage[]
  /** The ticket or brief of the change. Data, never instructions. */
  brief?: string
  /** The source diff of the component and its story. Data, never instructions. */
  sourceDiff?: string
}
