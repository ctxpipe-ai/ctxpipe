import { describe, expect, test } from "vitest"

import {
  packagedRubric,
  reviewStories,
  verdictSchema,
  type StoryInput,
  type Verdict,
} from "./index.ts"

const region = (changeType: "color-change" | "rendering-noise") => ({
  box: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
  changeType,
  position: "left" as const,
  confidence: 0.9,
})

const story = (
  storyId: string,
  signature: string | undefined,
  overrides: Partial<StoryInput> = {},
): StoryInput => ({
  storyId,
  scope: "component",
  rubric: packagedRubric,
  viewport: { width: 1440, height: 900 },
  regions: [region("color-change")],
  images: [{ role: "regions", path: `/tmp/${storyId}/regions.png` }],
  ...(signature === undefined ? {} : { signature }),
  ...overrides,
})

const verdict = (
  storyId: string,
  overrides: Partial<Verdict> = {},
): Verdict => ({
  storyId,
  observations: [],
  verdict: "intended",
  severity: "none",
  confidence: 0.9,
  summary: "The badge is red now, as the brief asks.",
  qualities: [],
  findings: [],
  model: "anthropic/claude-sonnet-4.5",
  costUsd: 0.02,
  latencyMs: 4000,
  ...overrides,
})

// A judge that records its calls, and answers with `answer`.
function judge(
  answer: (story: StoryInput) => Verdict = ({ storyId }) => verdict(storyId),
) {
  const calls: string[] = []
  return {
    calls,
    judge: async (input: StoryInput) => {
      calls.push(input.storyId)
      return answer(input)
    },
  }
}

describe("reviewStories", () => {
  test("a story with only rendering noise is noise, with no call to the judge", async () => {
    const { calls, judge: fake } = judge()
    const noisy = story("a--noisy", "rendering-noise@left:288x90", {
      regions: [region("rendering-noise"), region("rendering-noise")],
    })

    const [result] = await reviewStories([noisy], fake)

    expect(calls).toEqual([])
    expect(result).toMatchObject({
      storyId: "a--noisy",
      verdict: "noise",
      severity: "none",
      costUsd: 0,
      model: "none",
    })
    expect(verdictSchema.safeParse(result).success).toBe(true)
  })

  test("a story with noise and one real region goes to the judge", async () => {
    const { calls, judge: fake } = judge()
    const mixed = story("a--mixed", "x", {
      regions: [region("rendering-noise"), region("color-change")],
    })

    await reviewStories([mixed], fake)

    expect(calls).toEqual(["a--mixed"])
  })

  test("a story with no region is not noise: it goes to the judge", async () => {
    const { calls, judge: fake } = judge()

    await reviewStories([story("a--resized", undefined, { regions: [] })], fake)

    expect(calls).toEqual(["a--resized"])
  })

  test("a 30-story ripple with one signature is one representative call plus a sample", async () => {
    const { calls, judge: fake } = judge()
    const ripple = Array.from({ length: 30 }, (_, i) =>
      story(`ripple--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(ripple, fake)

    expect(calls).toHaveLength(3)
    expect(calls[0]).toBe("ripple--story-0")
    expect(results).toHaveLength(30)
    expect(results.map(({ storyId }) => storyId)).toEqual(
      ripple.map(({ storyId }) => storyId),
    )
    const grouped = results.filter(({ groupedWith }) => groupedWith)
    expect(grouped).toHaveLength(27)
    expect(new Set(grouped.map(({ groupedWith }) => groupedWith))).toEqual(
      new Set(["ripple--story-0"]),
    )
    // The grouped verdicts copy the judgement. They cost nothing more.
    for (const result of grouped) {
      expect(result).toMatchObject({
        verdict: "intended",
        costUsd: 0,
        latencyMs: 0,
      })
      expect(verdictSchema.safeParse(result).success).toBe(true)
    }
    // The judged stories are not marked as grouped.
    expect(
      results
        .filter(({ groupedWith }) => !groupedWith)
        .map(({ storyId }) => storyId)
        .sort(),
    ).toEqual([...calls].sort())
  })

  test("a group no larger than the representative plus the sample is judged story by story", async () => {
    const { calls, judge: fake } = judge()
    const small = [0, 1, 2].map((i) =>
      story(`small--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(small, fake)

    expect([...calls].sort()).toEqual(small.map(({ storyId }) => storyId))
    expect(results.some(({ groupedWith }) => groupedWith)).toBe(false)
  })

  test("stories with other signatures are other groups", async () => {
    const { calls, judge: fake } = judge()
    const stories = [
      ...Array.from({ length: 5 }, (_, i) =>
        story(`card--story-${i}`, "color-change@left:288x90"),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        story(`table--story-${i}`, "deletion@bottom:600x40"),
      ),
    ]

    await reviewStories(stories, fake)

    // One representative and two samples for each group.
    expect(calls.filter((id) => id.startsWith("card"))).toHaveLength(3)
    expect(calls.filter((id) => id.startsWith("table"))).toHaveLength(3)
  })

  test("a page story and a component story are not in one group", async () => {
    const { calls, judge: fake } = judge()
    const stories = [
      ...Array.from({ length: 4 }, (_, i) =>
        story(`part--story-${i}`, "color-change@left:288x90"),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        story(`page--story-${i}`, "color-change@left:288x90", {
          scope: "page",
        }),
      ),
    ]

    await reviewStories(stories, fake)

    expect(calls.filter((id) => id.startsWith("part"))).toHaveLength(3)
    expect(calls.filter((id) => id.startsWith("page"))).toHaveLength(3)
  })

  test("a desktop story and a mobile story are not in one group", async () => {
    const { calls, judge: fake } = judge()
    const stories = [
      ...Array.from({ length: 4 }, (_, i) =>
        story(`wide--story-${i}`, "color-change@left:288x90"),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        story(`narrow--story-${i}`, "color-change@left:288x90", {
          viewport: { width: 390, height: 844 },
        }),
      ),
    ]

    await reviewStories(stories, fake)

    expect(calls.filter((id) => id.startsWith("wide"))).toHaveLength(3)
    expect(calls.filter((id) => id.startsWith("narrow"))).toHaveLength(3)
  })

  test("stories with no signature are judged one by one", async () => {
    const { calls, judge: fake } = judge()
    const stories = Array.from({ length: 6 }, (_, i) =>
      story(`resized--story-${i}`, undefined, { regions: [] }),
    )

    await reviewStories(stories, fake)

    expect(calls).toHaveLength(6)
  })

  test("a signature that differs by a few pixels in size is the same group", async () => {
    const { calls, judge: fake } = judge()
    // The same change, with a box that is a few px wider or higher.
    const sizes = ["288x90", "289x90", "288x91", "290x92", "287x89", "288x90"]
    const stories = sizes.map((size, i) =>
      story(`near--story-${i}`, `color-change@left:${size}`),
    )

    const results = await reviewStories(stories, fake)

    expect(calls).toHaveLength(3)
    expect(results.filter(({ groupedWith }) => groupedWith)).toHaveLength(3)
  })

  test("a small region has a tolerance of 2 px", async () => {
    const { calls, judge: fake } = judge()
    const stories = ["20x20", "21x20", "22x20", "23x20"].map((size, i) =>
      story(`small--story-${i}`, `color-change@left:${size}`),
    )

    const results = await reviewStories(stories, fake)

    // Widths 20 to 22 are one group of three, judged story by story. The
    // width 23 is 3 px from the first: another group.
    expect(calls).toHaveLength(4)
    expect(results.some(({ groupedWith }) => groupedWith)).toBe(false)
  })

  test("a signature with a size that differs a lot is another group", async () => {
    const { calls, judge: fake } = judge()
    const stories = [
      ...Array.from({ length: 4 }, (_, i) =>
        story(`near--story-${i}`, "color-change@left:288x90"),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        story(`far--story-${i}`, "color-change@left:388x90"),
      ),
    ]

    await reviewStories(stories, fake)

    expect(calls.filter((id) => id.startsWith("near"))).toHaveLength(3)
    expect(calls.filter((id) => id.startsWith("far"))).toHaveLength(3)
  })

  test("a large region has a larger tolerance, 2 % of its size", async () => {
    const { calls, judge: fake } = judge()
    const stories = [
      story("big--story-0", "color-change@center:1000x400"),
      story("big--story-1", "color-change@center:1015x400"),
      story("big--story-2", "color-change@center:1000x392"),
      story("big--story-3", "color-change@center:985x400"),
      story("big--story-4", "color-change@center:1010x400"),
      story("big--story-5", "color-change@center:1100x400"),
    ]

    const results = await reviewStories(stories, fake)

    // Five stories are one group: one representative and two samples. The
    // sixth is 100 px wider, and goes alone.
    expect(calls).toHaveLength(4)
    expect(calls).toContain("big--story-5")
    expect(results.filter(({ groupedWith }) => groupedWith)).toHaveLength(2)
  })

  test("signatures with other change types or other positions are not alike", async () => {
    const { calls, judge: fake } = judge()
    const stories = [
      story("kind--story-0", "color-change@left:288x90"),
      story("kind--story-1", "deletion@left:288x90"),
      story("kind--story-2", "color-change@right:288x90"),
      story("kind--story-3", "color-change@left:288x90,deletion@top:20x20"),
    ]

    await reviewStories(stories, fake)

    expect(calls).toHaveLength(4)
  })

  test("regions in a different order in the signature still match", async () => {
    const { calls, judge: fake } = judge()
    const stories = Array.from({ length: 5 }, (_, i) =>
      story(
        `order--story-${i}`,
        i % 2
          ? "color-change@left:288x90,deletion@top:100x20"
          : "deletion@top:101x20,color-change@left:288x90",
      ),
    )

    await reviewStories(stories, fake)

    expect(calls).toHaveLength(3)
  })

  test("the group does not drift: a story is compared with its representative, not with the story before it", async () => {
    const { calls, judge: fake } = judge()
    // The tolerance of a 100 px box is 2 px. Each step is 2 px.
    const stories = [100, 102, 104, 106, 108].map((width, i) =>
      story(`drift--story-${i}`, `color-change@left:${width}x90`),
    )

    const results = await reviewStories(stories, fake)

    // Groups: 100 and 102; 104 and 106; 108. A chain would make one group,
    // and judge three stories.
    expect(calls).toHaveLength(5)
    expect(results.some(({ groupedWith }) => groupedWith)).toBe(false)
  })

  test("a sample that disagrees with the representative makes the rest of the group unsure", async () => {
    const { calls, judge: fake } = judge(({ storyId }) =>
      storyId === "ripple--story-0"
        ? verdict(storyId)
        : verdict(storyId, {
            verdict: "regression",
            severity: "major",
            summary: "The badge text is cut.",
          }),
    )
    const ripple = Array.from({ length: 10 }, (_, i) =>
      story(`ripple--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(ripple, fake)

    expect(calls).toHaveLength(3)
    const rest = results.filter(({ groupedWith }) => groupedWith)
    expect(rest).toHaveLength(7)
    for (const result of rest) {
      expect(result).toMatchObject({
        verdict: "unsure",
        severity: "none",
        groupedWith: "ripple--story-0",
        costUsd: 0,
      })
      expect(result.summary).toMatch(/judged stories of the group disagree/i)
    }
    // The judged stories keep their own verdicts.
    const sample = results.filter(
      ({ storyId, groupedWith }) =>
        !groupedWith && storyId !== "ripple--story-0",
    )
    expect(sample).toHaveLength(2)
    expect(sample.every(({ verdict }) => verdict === "regression")).toBe(true)
  })

  test("a judged story with an error makes the rest of the group unsure, with that error", async () => {
    const { judge: fake } = judge(({ storyId }) =>
      storyId === "ripple--story-7"
        ? verdict(storyId, {
            verdict: "unsure",
            severity: "none",
            summary: "Budget reached: no model judged this screenshot.",
            error: "Budget reached: the run spent 0.0200 USD.",
          })
        : verdict(storyId),
    )
    const ripple = Array.from({ length: 10 }, (_, i) =>
      story(`ripple--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(ripple, fake)

    const rest = results.filter(({ groupedWith }) => groupedWith)
    expect(rest).toHaveLength(7)
    for (const result of rest) {
      expect(result).toMatchObject({
        verdict: "unsure",
        error: "Budget reached: the run spent 0.0200 USD.",
      })
      expect(result.summary).toContain("ripple--story-7 of the group")
    }
  })

  test("the same verdict with another severity is a disagreement", async () => {
    const { judge: fake } = judge(({ storyId }) =>
      verdict(storyId, {
        verdict: "regression",
        severity: storyId === "ripple--story-0" ? "minor" : "major",
      }),
    )
    const ripple = Array.from({ length: 10 }, (_, i) =>
      story(`ripple--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(ripple, fake)

    expect(results.filter(({ verdict }) => verdict === "unsure")).toHaveLength(
      7,
    )
  })

  test("when the judge agrees, a grouped regression is a regression for the rest, with no findings of its own", async () => {
    const { judge: fake } = judge(({ storyId }) =>
      verdict(storyId, {
        verdict: "regression",
        severity: "major",
        summary: "The badge text is cut.",
        observations: [
          { region: 1, before: "A badge.", after: "A cut badge." },
        ],
        qualities: [{ name: "clarity", delta: "worse", confidence: 0.8 }],
        findings: [
          {
            kind: "overflow",
            region: { x: 0.1, y: 0.2, width: 0.1, height: 0.05 },
            evidence: "The text ends at the box edge.",
            rubricRef: "apps/ui/DESIGN.md",
            explainedByBrief: false,
            suggestion: "Allow two lines.",
          },
        ],
      }),
    )
    const ripple = Array.from({ length: 8 }, (_, i) =>
      story(`ripple--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(ripple, fake)

    const rest = results.filter(({ groupedWith }) => groupedWith)
    expect(rest).toHaveLength(5)
    expect(rest[0]).toMatchObject({
      verdict: "regression",
      severity: "major",
      confidence: 0.9,
      observations: [],
      qualities: [],
      findings: [],
    })
    expect(rest[0]?.summary).toBe(
      "Same diff as ripple--story-0. 3 judged stories of the group gave the verdict regression with severity major.",
    )
    expect(verdictSchema.safeParse(rest[0]).success).toBe(true)
  })

  test("regions of one type and position pair up even when the first choice is wrong", async () => {
    const { calls, judge: fake } = judge()
    // 100 is near 101 and 99, 102 is near only 101 and 99... 100 must take 99.
    const stories = Array.from({ length: 6 }, (_, i) =>
      story(
        `pair--story-${i}`,
        i % 2
          ? "color-change@left:101x20,color-change@left:99x20"
          : "color-change@left:100x20,color-change@left:102x20",
      ),
    )

    await reviewStories(stories, fake)

    expect(calls).toHaveLength(3)
  })

  test("the confidence of a grouped story is the lowest of the judged verdicts", async () => {
    const { judge: fake } = judge(({ storyId }) =>
      verdict(storyId, {
        confidence: storyId === "ripple--story-0" ? 0.9 : 0.6,
      }),
    )
    const ripple = Array.from({ length: 8 }, (_, i) =>
      story(`ripple--story-${i}`, "color-change@left:288x90"),
    )

    const results = await reviewStories(ripple, fake)

    const rest = results.filter(({ groupedWith }) => groupedWith)
    expect(rest.every(({ confidence }) => confidence === 0.6)).toBe(true)
  })

  test("a stray rendering-noise region does not split a group", async () => {
    const { calls, judge: fake } = judge()
    const stories = Array.from({ length: 6 }, (_, i) =>
      story(
        `noise--story-${i}`,
        i % 2
          ? "color-change@left:288x90,rendering-noise@bottom:4x4"
          : "color-change@left:288x90",
      ),
    )

    await reviewStories(stories, fake)

    expect(calls).toHaveLength(3)
  })

  test("regions pair up whatever the order of the sizes", async () => {
    const { calls, judge: fake } = judge()
    // Two regions of one type and position. Sorted by width, the pairs would
    // cross: 100x20 with 102x20 is near, but 101x100 with 100x100 is too.
    const stories = Array.from({ length: 30 }, (_, i) =>
      story(
        `cross--story-${i}`,
        i % 2
          ? "color-change@left:102x20,color-change@left:100x100"
          : "color-change@left:100x20,color-change@left:101x100",
      ),
    )

    await reviewStories(stories, fake)

    expect(calls).toHaveLength(3)
  })

  test("a failed call to the judge fails the review, so the caller can retry", async () => {
    const failing = async () => {
      throw new Error("The provider is down.")
    }

    await expect(
      reviewStories([story("a--b", "color-change@left:288x90")], failing),
    ).rejects.toThrow("The provider is down.")
  })
})
