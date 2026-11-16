import { createHash } from "node:crypto"

import { decode } from "@blazediff/codec-png-native"

/** A committed baseline of one story. */
type Baseline = {
  /** The baseline file, from the repository root. */
  path: string
  /** The story of the baseline: `<story file>#<export name>`. */
  story: string
  png: Uint8Array
  /**
   * The reason of the story (`parameters.visual.duplicate`) why its
   * screenshot may be the same as the screenshot of another story, if any.
   */
  duplicate?: string
}

/**
 * The groups of baselines of different stories that have the same pixels
 * (the same size and the same color of each pixel). Each story must show its
 * own UI state, so a group fails. A story with a `duplicate` reason may share
 * the pixels of one story with no reason: a group fails when two or more of
 * its stories have no reason. Two baselines of one story (a named snapshot
 * and the end state) are not a duplicate.
 */
export function duplicateBaselines(baselines: readonly Baseline[]): string[][] {
  const groups = Map.groupBy(baselines, (baseline) => {
    const { data, width, height } = decode(baseline.png)
    return createHash("sha256")
      .update(`${width}x${height}:`)
      .update(data)
      .digest("hex")
  })
  return [...groups.values()]
    .filter(
      (group) =>
        new Set(
          group
            .filter((baseline) => !baseline.duplicate)
            .map((baseline) => baseline.story),
        ).size > 1,
    )
    .map((group) => group.map((baseline) => baseline.path).sort())
}
