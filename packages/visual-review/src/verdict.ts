import { z } from "zod"

import { areas, qualities, type AreaId, type QualityId } from "./rubric.ts"
import type { StoryInput } from "./story.ts"

const fraction = z.number().min(0).max(1)

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
  severity: z.enum(["none", "minor", "major", "blocker"]),
  confidence: fraction,
  summary: z.string(),
  qualities: z.array(
    z.object({
      name: z.enum(
        qualities.map(({ id }) => id) as [QualityId, ...QualityId[]],
      ),
      delta: z.enum(["better", "same", "worse"]),
      confidence: fraction,
    }),
  ),
  findings: z.array(
    z.object({
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
    }),
  ),
})

/** The model's part of a verdict, as JSON Schema for `response_format`. */
export const judgementJsonSchema = z.toJSONSchema(judgementSchema)

export type Judgement = z.infer<typeof judgementSchema>

/** The facts of one judge call. `costUsd` is null when the cost is unknown. */
export type RunFacts = {
  model: string
  costUsd: number | null
  latencyMs: number
}

/** The verdict on one story. `error` is set when the reply was not usable. */
export type Verdict = { storyId: string } & Judgement &
  RunFacts & { error?: string }

const pageOnly = new Set<string>(
  qualities.filter((quality) => quality.pageOnly).map(({ id }) => id),
)

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
  story: StoryInput,
  run: RunFacts,
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
  const parsed = judgementSchema.safeParse(json)
  if (!parsed.success)
    return unusable(
      `The reply does not match the schema:\n${z.prettifyError(parsed.error)}`,
    )
  const judgement = parsed.data
  if (story.scope !== "page")
    judgement.qualities = judgement.qualities.filter(
      ({ name }) => !pageOnly.has(name),
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
