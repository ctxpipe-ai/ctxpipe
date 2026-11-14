import { z } from "zod"

import { rubricId, type Rubric } from "./rubric.ts"
import type { NewStoryInput, StoryInput } from "./story.ts"

const fraction = z.number().min(0).max(1)
const severity = z.enum(["none", "minor", "major", "blocker"])

/**
 * The objects that a model writes, with `kind` (an area id) and `qualityName`
 * (a quality id). Property order is the order in which a model generates the
 * fields: it describes each region before it decides.
 */
function judgementSchemas(
  kind: z.ZodType<string>,
  qualityName: z.ZodType<string>,
) {
  const finding = z.object({
    kind,
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
  return {
    judgement: z.object({
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
    }),
    // The object for a new screenshot, one with no base image. There is no
    // diff: thus there is no `noise`, an observation describes one part of
    // the screenshot, and each quality gets a rating, not a delta.
    newJudgement: z.object({
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
    }),
  }
}

/** The schemas of a reply that names only the areas and qualities of `rubric`. */
const schemasOf = ({ areas, qualities }: Rubric) => {
  const ids = (entries: readonly { id: string }[]) =>
    z.enum(entries.map(({ id }) => id) as [string, ...string[]])
  return judgementSchemas(ids(areas), ids(qualities))
}

/** The model's part of a verdict, as JSON Schema for `response_format`. */
export const judgementJsonSchema = (rubric: Rubric) =>
  z.toJSONSchema(schemasOf(rubric).judgement)

/** The model's part of a verdict on a new screenshot, as JSON Schema. */
export const newJudgementJsonSchema = (rubric: Rubric) =>
  z.toJSONSchema(schemasOf(rubric).newJudgement)

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
 * The reader takes any area and quality id, because a verdict can come from
 * another rubric, such as the rubric of a PR head.
 *
 * A verdict on a new screenshot (see `parseNewVerdict`) has the same fields,
 * so a reader reads one shape: the `before` of each observation is empty,
 * because there is no base image, and the `delta` of each quality is `meets`,
 * `weak` or `fails`, the rating of the screenshot on its own. A verdict on a
 * change keeps `better`, `same` or `worse`.
 */
export const verdictSchema = judgementSchemas(
  rubricId,
  rubricId,
).judgement.extend({
  qualities: z.array(
    z.object({
      name: rubricId,
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
 * `page`. The reply may name only the areas and qualities of the rubric of
 * the story.
 */
export function parseVerdict(
  text: string,
  story: StoryInput,
  run: RunFacts,
): Verdict {
  return parseReply(
    text,
    story,
    run,
    schemasOf(story.rubric).judgement,
    (reply) => reply,
  )
}

/**
 * Read the reply on a new screenshot (`newJudgementJsonSchema`) as a verdict,
 * with the same rules as `parseVerdict`. Each observation becomes one with an
 * empty `before`, and each quality rating becomes its `delta`.
 */
export function parseNewVerdict(
  text: string,
  story: NewStoryInput,
  run: RunFacts,
): Verdict {
  return parseReply(
    text,
    story,
    run,
    schemasOf(story.rubric).newJudgement,
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

/**
 * Read the text of a model reply as JSON that matches `schema`. A reply in a
 * Markdown code fence is read without the fence. Returns the data, or the
 * cause when the reply is not usable. The judge panel of the bake-off
 * (evals/critic/panel.ts) reads its replies with it too.
 */
export function parseJsonReply<T>(
  text: string,
  schema: z.ZodType<T>,
): { data: T } | { error: string } {
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim())?.[1]
  let json: unknown
  try {
    json = JSON.parse(body ?? text)
  } catch (error) {
    return { error: `The reply is not JSON: ${(error as Error).message}` }
  }
  const parsed = schema.safeParse(json)
  return parsed.success
    ? { data: parsed.data }
    : {
        error: `The reply does not match the schema:\n${z.prettifyError(parsed.error)}`,
      }
}

function parseReply<T>(
  text: string,
  story: StoryInput | NewStoryInput,
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
  const reply = parseJsonReply(text, schema)
  if ("error" in reply) return unusable(reply.error)
  const judgement = toJudgement(reply.data)
  if (story.scope !== "page")
    judgement.qualities = judgement.qualities.filter(
      ({ name }) =>
        !story.rubric.qualities.find(({ id }) => id === name)?.pageOnly,
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
