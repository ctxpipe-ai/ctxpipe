import type { StoryInput } from "./story.ts"
import type { Verdict } from "./verdict.ts"

type Part = { change: string; position: string; width: number; height: number }

/**
 * The regions of a signature (`type@position:WxH`, joined by commas), or null
 * when the signature is empty or has another format.
 */
function parseSignature(signature: string | undefined): Part[] | null {
  if (!signature) return null
  const parts: Part[] = []
  for (const text of signature.split(",")) {
    const match = /^([^@]+)@([^:]+):(\d+)x(\d+)$/.exec(text)
    if (!match) return null
    parts.push({
      change: match[1] ?? "",
      position: match[2] ?? "",
      width: Number(match[3]),
      height: Number(match[4]),
    })
  }
  return parts
}

// A side of a region may differ by 2 px, or by 2 % of the side when that is
// more. Text and sub-pixel layout move a box by a pixel or two between two
// stories that show the same change.
const near = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(2, Math.round(0.02 * Math.max(a, b)))

/**
 * True when each region of `a` has its own region in `b` with the same change
 * type and position, and sizes that are near. A region is paired with the
 * first free region of `b` that matches, so the order of the signature does
 * not matter.
 */
function alike(a: Part[], b: Part[]): boolean {
  const free = [...b]
  return (
    a.length === b.length &&
    a.every((part) => {
      const at = free.findIndex(
        (other) =>
          other.change === part.change &&
          other.position === part.position &&
          near(other.width, part.width) &&
          near(other.height, part.height),
      )
      if (at < 0) return false
      free.splice(at, 1)
      return true
    })
  )
}

type Member = { story: StoryInput; index: number }
// The first member is the representative.
type Group = {
  /** Null for a story with no usable signature: a group of its own. */
  parts: Part[] | null
  members: [Member, ...Member[]]
}

/**
 * Review many stories of one run. Judging is the expensive step, so this
 * does as little of it as it can:
 * 1. A story whose regions are all `rendering-noise` is `noise`, with no call.
 * 2. The other stories form groups: the same scope, the same viewport, and a
 *    diff signature (change types, positions and sizes of the regions) that
 *    is alike. A size may differ by 2 px or 2 %. A story is compared with the
 *    first story of the group, never with the story before it, so a group
 *    cannot drift. A story with no signature is a group of its own.
 * 3. `judge` runs for the first story of a group, the representative, and for
 *    2 more stories, spread evenly over the group. Their verdicts are their
 *    own. When all judged verdicts have one verdict and one severity, each
 *    other story gets that verdict, with `groupedWith` set and no evidence of
 *    its own (see `Verdict`). When they differ, the group is not uniform, and
 *    each other story gets `unsure`. A group of three or fewer is judged story
 *    by story.
 *
 * The verdicts come in the order of `stories`. A failed `judge` call fails
 * the review: the caller can retry it.
 */
export async function reviewStories(
  stories: readonly StoryInput[],
  judge: (story: StoryInput) => Promise<Verdict>,
): Promise<Verdict[]> {
  const sample = 2
  const verdicts: Verdict[] = []
  const groups: Group[] = []
  stories.forEach((story, index) => {
    if (
      story.regions.length > 0 &&
      story.regions.every(({ changeType }) => changeType === "rendering-noise")
    ) {
      verdicts[index] = noiseVerdict(story)
      return
    }
    const member = { story, index }
    const parts = parseSignature(story.signature)
    const group = parts
      ? groups.find(
          (candidate) =>
            candidate.parts &&
            alike(candidate.parts, parts) &&
            candidate.members[0].story.scope === story.scope &&
            candidate.members[0].story.viewport.width ===
              story.viewport.width &&
            candidate.members[0].story.viewport.height ===
              story.viewport.height,
        )
      : undefined
    if (group) group.members.push(member)
    else groups.push({ parts, members: [member] })
  })

  for (const {
    members: [first, ...rest],
  } of groups) {
    // The picks are evenly spaced. A small group has no pick left over.
    const count = Math.min(sample, rest.length)
    const picked = new Set(
      Array.from({ length: count }, (_, k) =>
        Math.floor(((k + 0.5) * rest.length) / count),
      ),
    )
    const representative = await judge(first.story)
    verdicts[first.index] = representative
    let uniform = true
    for (const member of rest.filter((_, i) => picked.has(i))) {
      const verdict = await judge(member.story)
      verdicts[member.index] = verdict
      uniform &&=
        verdict.verdict === representative.verdict &&
        verdict.severity === representative.severity
    }
    for (const { story, index } of rest.filter((_, i) => !picked.has(i)))
      verdicts[index] = grouped(story.storyId, representative, uniform)
  }
  return verdicts
}

function noiseVerdict({ storyId, regions }: StoryInput): Verdict {
  return {
    storyId,
    observations: [],
    verdict: "noise",
    severity: "none",
    confidence: 1,
    summary: `All ${regions.length} measured ${regions.length === 1 ? "region is" : "regions are"} rendering noise. No model judged this story.`,
    qualities: [],
    findings: [],
    model: "none",
    costUsd: 0,
    latencyMs: 0,
  }
}

// The classification of the group, with no evidence of its own: the
// observations, qualities and findings of the representative are about the
// pictures of that story, which the model did not see for this story.
function grouped(
  storyId: string,
  representative: Verdict,
  uniform: boolean,
): Verdict {
  const run = {
    storyId,
    observations: [],
    qualities: [],
    findings: [],
    model: representative.model,
    costUsd: 0,
    latencyMs: 0,
    groupedWith: representative.storyId,
  }
  if (!uniform)
    return {
      ...run,
      verdict: "unsure",
      severity: "none",
      confidence: 0,
      summary: `The judged stories of the group disagree, so ${representative.storyId} cannot stand for this story. Judge it on its own.`,
    }
  return {
    ...run,
    verdict: representative.verdict,
    severity: representative.severity,
    confidence: representative.confidence,
    summary: `Same diff as ${representative.storyId}: ${representative.summary}`,
  }
}
