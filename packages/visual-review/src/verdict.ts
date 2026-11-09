import { z } from "zod"

import { areas, qualities, type AreaId, type QualityId } from "./rubric.ts"
import type { NewStoryInput, StoryInput } from "./story.ts"

const fraction = z.number().min(0).max(1)
const qualityName = z.enum(
  qualities.map(({ id }) => id) as [QualityId, ...QualityId[]],
)
const severity = z.enum(["none", "minor", "major", "blocker"])
const finding = z.object({
  kind: z.enum(areas.map(({ id }) => id) as [AreaId, ...AreaId[]]),
  region: z.object({
    x: fraction,
    y: fraction,
    width: fraction,
    height: fraction,
  }),
  evidence: z.string(),
  rubricRef: z.string(),
  explainedByBrief: z.boolean(),
  suggestion: z.string().nullable(),
})

// The object that the model writes. Property order is the order in which a
// model generates the fields: it describes each region before it decides.
const judgementSchema = z.object({
  observations: z.array(
    z.object({
      region: z.number().int().min(1),
      before: z.string(),
      after: z.string(),
    }),
  ),
  verdict: z.enum(["intended", "regression", "noise", "unsure"]),
  severity,
  confidence: fraction,
  summary: z.string(),
  qualities: z.array(
    z.object({
      name: qualityName,
      delta: z.enum(["better", "same", "worse"]),
      confidence: fraction,
    }),
  ),
  findings: z.array(finding),
})

// The object that the model writes for a new screenshot, one with no base
// image. There is no diff: thus there is no `noise`, an observation describes
// one part of the screenshot, and each quality gets a rating, not a delta.
const newJudgementSchema = z.object({
  observations: z.array(
    z.object({ part: z.number().int().min(1), seen: z.string() }),
  ),
  verdict: z.enum(["intended", "regression", "unsure"]),
  severity,
  confidence: fraction,
  summary: z.string(),
  qualities: z.array(
    z.object({
      name: qualityName,
      rating: z.enum(["meets", "weak", "fails"]),
      confidence: fraction,
    }),
  ),
  findings: z.array(finding),
})

/** The model's part of a verdict, as JSON Schema for `response_format`. */
export const judgementJsonSchema = z.toJSONSchema(judgementSchema)

/** The model's part of a verdict on a new screenshot, as JSON Schema. */
export const newJudgementJsonSchema = z.toJSONSchema(newJudgementSchema)

/** The facts of one judge call. `costUsd` is null when the cost is unknown. */
export type RunFacts = {
  model: string
  costUsd: number | null
  latencyMs: number
}

/**
 * The verdict on one story: the judgement, the story id and the run facts.
 * `error` is set when the reply was not usable. A reader of a stored verdict
 * (for example the output of `pnpm visual:review`) validates it with this.
 *
 * A verdict on a new screenshot (see `parseNewVerdict`) has the same fields,
 * so a reader reads one shape: the `before` of each observation is empty,
 * because there is no base image, and the `delta` of each quality is `meets`,
 * `weak` or `fails`, the rating of the screenshot on its own. A verdict on a
 * change keeps `better`, `same` or `worse`.
 */
export const verdictSchema = judgementSchema.extend({
  qualities: z.array(
    z.object({
      name: qualityName,
      delta: z.enum(["better", "same", "worse", "meets", "weak", "fails"]),
      confidence: fraction,
    }),
  ),
  storyId: z.string(),
  model: z.string(),
  costUsd: z.number().min(0).nullable(),
  latencyMs: z.number().min(0),
  error: z.string().optional(),
  /**
   * The id of the story that a judge looked at, for a verdict that is a copy
   * for another story of its group (see `reviewStories`). Its cost and latency
   * are zero. Absent when a judge looked at this story, or when the story was
   * noise.
   */
  groupedWith: z.string().optional(),
})

export type Verdict = z.infer<typeof verdictSchema>

/** What the reply rules need to know about the judged story. */
type Judged = StoryInput | NewStoryInput

type Judgement = Omit<
  Verdict,
  "storyId" | "model" | "costUsd" | "latencyMs" | "error" | "groupedWith"
>

/**
 * Read the text of a judge reply as a verdict on `story`. Text that is not
 * JSON, or JSON that does not match the schema, gives the verdict `unsure`
 * with the cause in `error`. The prompt rules that code can check are
 * enforced here: `intended` stands only when a brief or a source diff explains
 * every finding, and a page-only quality is dropped when the scope is not
 * `page`.
 */
export function parseVerdict(
  text: string,
  story: Judged,
  run: RunFacts,
): Verdict {
  return parseReply(text, story, run, judgementSchema, (reply) => reply)
}

/**
 * Read the reply on a new screenshot (`newJudgementJsonSchema`) as a verdict,
 * with the same rules as `parseVerdict`. Each observation becomes one with an
 * empty `before`, and each quality rating becomes its `delta`.
 */
export function parseNewVerdict(
  text: string,
  story: Judged,
  run: RunFacts,
): Verdict {
  return parseReply(
    text,
    story,
    run,
    newJudgementSchema,
    ({ observations, qualities, ...rest }) => ({
      ...rest,
      observations: observations.map(({ part, seen }) => ({
        region: part,
        before: "",
        after: seen,
      })),
      qualities: qualities.map(({ name, rating, confidence }) => ({
        name,
        delta: rating,
        confidence,
      })),
    }),
  )
}

function parseReply<T>(
  text: string,
  story: Judged,
  run: RunFacts,
  schema: z.ZodType<T>,
  toJudgement: (reply: T) => Judgement,
): Verdict {
  const unusable = (error: string): Verdict => ({
    storyId: story.storyId,
    observations: [],
    verdict: "unsure",
    severity: "none",
    confidence: 0,
    summary: "The critic reply was not usable.",
    qualities: [],
    findings: [],
    ...run,
    error,
  })
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim())?.[1]
  let json: unknown
  try {
    json = JSON.parse(body ?? text)
  } catch (error) {
    return unusable(`The reply is not JSON: ${(error as Error).message}`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success)
    return unusable(
      `The reply does not match the schema:\n${z.prettifyError(parsed.error)}`,
    )
  const judgement = toJudgement(parsed.data)
  if (story.scope !== "page")
    judgement.qualities = judgement.qualities.filter(
      ({ name }) => !qualities.find(({ id }) => id === name)?.pageOnly,
    )
  if (judgement.verdict === "intended") {
    const reason =
      !story.brief?.trim() && !story.sourceDiff?.trim()
        ? "No brief or source diff explains the change."
        : judgement.findings.some((finding) => !finding.explainedByBrief)
          ? "A finding is not explained by the brief or the source diff."
          : undefined
    if (reason) {
      judgement.verdict = "unsure"
      judgement.summary = `${reason} The critic said intended: ${judgement.summary}`
    }
  }
  return { storyId: story.storyId, ...judgement, ...run }
}
