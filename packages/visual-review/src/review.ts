import type { StoryInput } from "./story.ts"
import type { Verdict } from "./verdict.ts"

type Part = { change: string; position: string; width: number; height: number }

/**
 * The regions of a signature (`type@position:WxH`, joined by commas), in a
 * fixed order, or null when the signature is empty or has another format.
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
  return parts.sort(
    (a, b) =>
      a.change.localeCompare(b.change) ||
      a.position.localeCompare(b.position) ||
      a.width - b.width ||
      a.height - b.height,
  )
}

// A side of a region may differ by 2 px, or by 2 % of the side when that is
// more. Text and sub-pixel layout move a box by a pixel or two between two
// stories that show the same change.
const near = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(2, Math.round(0.02 * Math.max(a, b)))

function alike(a: Part[], b: Part[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (part, i) =>
        part.change === b[i]?.change &&
        part.position === b[i]?.position &&
        near(part.width, b[i]?.width ?? 0) &&
        near(part.height, b[i]?.height ?? 0),
    )
  )
}

type Group = { story: StoryInput; parts: Part[]; members: number[] }

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
 *    `sample` more stories, spread evenly over the group. Their verdicts are
 *    their own. When all judged verdicts have one verdict and one severity,
 *    each other story gets a copy of the verdict of the representative, with
 *    `groupedWith` set. When they differ, the group is not uniform, and each
 *    other story gets `unsure`. A group that is not larger than the
 *    representative and the sample is judged story by story.
 *
 * The verdicts come in the order of `stories`. A failed `judge` call fails
 * the review: the caller can retry it. The caller prepares the images of a
 * story in `judge` (see `prepareImages`).
 */
export async function reviewStories(
  stories: readonly StoryInput[],
  judge: (story: StoryInput) => Promise<Verdict>,
  { sample = 2 }: { sample?: number } = {},
): Promise<Verdict[]> {
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
    const parts = parseSignature(story.signature)
    const group = parts
      ? groups.find(
          (candidate) =>
            alike(candidate.parts, parts) &&
            candidate.story.scope === story.scope &&
            candidate.story.viewport.width === story.viewport.width &&
            candidate.story.viewport.height === story.viewport.height,
        )
      : undefined
    if (group) group.members.push(index)
    else groups.push({ story, parts: parts ?? [], members: [index] })
  })

  for (const { members } of groups) {
    const [first = 0, ...rest] = members
    const judged =
      members.length <= 1 + sample
        ? members
        : [
            first,
            ...Array.from(
              { length: sample },
              (_, k) =>
                rest[Math.floor(((k + 0.5) * rest.length) / sample)] ?? first,
            ),
          ]
    const results = await Promise.all(
      judged.map((index) => judge(stories[index] as StoryInput)),
    )
    judged.forEach((index, k) => {
      verdicts[index] = results[k] as Verdict
    })
    const representative = results[0] as Verdict
    const uniform = results.every(
      ({ verdict, severity }) =>
        verdict === representative.verdict &&
        severity === representative.severity,
    )
    for (const index of members.filter((i) => !judged.includes(i)))
      verdicts[index] = grouped(
        (stories[index] as StoryInput).storyId,
        representative,
        uniform,
      )
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

function grouped(
  storyId: string,
  representative: Verdict,
  uniform: boolean,
): Verdict {
  const run = {
    storyId,
    model: representative.model,
    costUsd: 0,
    latencyMs: 0,
    groupedWith: representative.storyId,
  }
  if (!uniform)
    return {
      ...run,
      observations: [],
      verdict: "unsure",
      severity: "none",
      confidence: 0,
      summary: `The judged stories of the group disagree, so ${representative.storyId} cannot stand for this story. Judge it on its own.`,
      qualities: [],
      findings: [],
    }
  return {
    ...representative,
    ...run,
    summary: `Same diff as ${representative.storyId}: ${representative.summary}`,
  }
}
