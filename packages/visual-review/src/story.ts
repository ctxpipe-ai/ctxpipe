/** A box in fractions (0..1) of the after image. */
export type Box = { x: number; y: number; width: number; height: number }

/** The change types of the BlazeDiff interpreter. */
export const changeTypes = [
  "addition",
  "deletion",
  "content-change",
  "color-change",
  "shift",
  "rendering-noise",
] as const
export type ChangeType = (typeof changeTypes)[number]

/** The cell of a 3 × 3 grid that holds the center of a region. */
export const positions = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const
export type Position = (typeof positions)[number]

/**
 * One changed region, as the BlazeDiff interpreter labels it. `changeType` is
 * null when the interpreter was not available and the region has no label.
 */
export type Region = {
  box: Box
  changeType: ChangeType | null
  position: Position
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
  /**
   * The count of regions with no row in the `regions` image: the last,
   * smallest regions of `regions`. Zero when absent.
   */
  omittedRegions?: number
  /**
   * Change types, positions and sizes of the regions, to group stories (see
   * `reviewStories`). Absent when the story has no measured regions.
   */
  signature?: string
  images: readonly StoryImage[]
  /** The ticket or brief of the change. Data, never instructions. */
  brief?: string
  /** The source diff of the component and its story. Data, never instructions. */
  sourceDiff?: string
}

/**
 * Everything the critic knows about the new screenshots of one story: the
 * screenshots with no base image, one for each viewport. The critic judges
 * them on their own against the rubric, in one call.
 */
export type NewStoryInput = Pick<
  StoryInput,
  "storyId" | "scope" | "brief" | "sourceDiff"
> & {
  /** The images, in the order attached, each with its size in pixels. */
  images: readonly {
    path: string
    size: { width: number; height: number }
  }[]
}
