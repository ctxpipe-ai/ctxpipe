import type { StoryInput } from "./story.ts"
import type { Verdict } from "./verdict.ts"

type Part = { change: string; position: string; width: number; height: number }

/**
 * The regions of a signature (`type@position:WxH`, joined by commas) without
 * the rendering-noise regions, or null when the signature is empty, has
 * another format, or has only noise. A stray noise region does not make one
 * story differ from another that shows the same real change.
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
  const real = parts.filter(({ change }) => change !== "rendering-noise")
  return real.length ? real : null
}

// A side of a region may differ by 2 px, or by 2 % of the side when that is
// more. Text and sub-pixel layout move a box by a pixel or two between two
// stories that show the same change.
const near = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(2, Math.round(0.02 * Math.max(a, b)))

/**
 * True when the regions of `a` and `b` pair one to one, each pair with the
 * same change type and position and sizes that are near. The order of the
 * regions does not matter. A region that has two near candidates may take the
 * place that another region needs, so the pairing is a bipartite match: a
 * taken place moves to another candidate when it can.
 */
function alike(a: Part[], b: Part[]): boolean {
  const takenBy: (Part | undefined)[] = []
  const pair = (part: Part, tried: Set<number>): boolean =>
    b.some((other, j) => {
      if (
        tried.has(j) ||
        other.change !== part.change ||
        other.position !== part.position ||
        !near(other.width, part.width) ||
        !near(other.height, part.height)
      )
        return false
      tried.add(j)
      const holder = takenBy[j]
      if (holder && !pair(holder, tried)) return false
      takenBy[j] = part
      return true
    })
  return a.length === b.length && a.every((part) => pair(part, new Set()))
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
 *    each other story gets `unsure`. When a judged verdict has an `error`,
 *    each other story gets `unsure` with that error. A group of three or
 *    fewer is judged story by story.
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
    const judged: [Verdict, ...Verdict[]] = [representative]
    for (const member of rest.filter((_, i) => picked.has(i))) {
      const verdict = await judge(member.story)
      verdicts[member.index] = verdict
      judged.push(verdict)
    }
    for (const { story, index } of rest.filter((_, i) => !picked.has(i)))
      verdicts[index] = grouped(story.storyId, judged)
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

// The classification of the group, with nothing of the representative that is
// about its own pictures: the model did not see the pictures of this story.
// The confidence is the lowest of the judged verdicts.
function grouped(storyId: string, judged: [Verdict, ...Verdict[]]): Verdict {
  const [representative] = judged
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
  // A judged story with no usable verdict (an unusable reply, or a budget
  // that stopped its call) cannot stand for the group: its error goes on.
  const failed = judged.find(({ error }) => error !== undefined)
  if (failed)
    return {
      ...run,
      verdict: "unsure",
      severity: "none",
      confidence: 0,
      summary: `${failed.storyId} of the group has no usable verdict, so it cannot stand for this story: ${failed.summary}`,
      error: failed.error,
    }
  const uniform = judged.every(
    ({ verdict, severity }) =>
      verdict === representative.verdict &&
      severity === representative.severity,
  )
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
    confidence: Math.min(...judged.map(({ confidence }) => confidence)),
    summary: `Same diff as ${representative.storyId}. ${judged.length} judged stories of the group gave the verdict ${representative.verdict} with severity ${representative.severity}.`,
  }
}
