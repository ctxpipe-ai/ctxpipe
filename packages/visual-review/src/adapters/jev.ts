// The Jev adapter: a cheap first filter for the visual critic. Jev (TypeSafe)
// answers typed questions with probabilities and no text, through the
// OpenRouter Decisions API. The adapter asks one question for each area and
// each quality, one question for a visible defect, and one for its region.
// It maps the answers onto the same verdict as the other judges.
import { readFile } from "node:fs/promises"

import { z } from "zod"

import { buildPrompt } from "../prompt.ts"
import { areas, qualities } from "../rubric.ts"
import type { Box, StoryImage, StoryInput } from "../story.ts"
import { parseVerdict, type Verdict } from "../verdict.ts"

type Question =
  | {
      type: "choice"
      instructions: string
      criteria: Record<"better" | "same" | "worse", string>
    }
  | { type: "noul"; instructions: string }
  | { type: "box"; instructions: string }

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Read one PNG for Jev and check its size from the header: width and height
 * are the big-endian numbers at bytes 16 to 23. Jev takes each side from 280
 * to 1568 px, which also keeps the total pixels within its limits. The
 * adapter does not pad or scale an image: preparing the images is the job of
 * the caller. Returns the data URL, or the reason that Jev cannot take it.
 */
async function readImage({
  role,
  path,
}: StoryImage): Promise<{ url: string } | { problem: string }> {
  const bytes = await readFile(path)
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return { problem: `Image ${role} (${path}) is not a PNG.` }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const within = (side: number) => side >= 280 && side <= 1568
  if (!within(width) || !within(height))
    return {
      problem: `Image ${role} (${path}) is ${width} x ${height} px. Jev takes each side from 280 to 1568 px.`,
    }
  return { url: `data:image/png;base64,${bytes.toString("base64")}` }
}

const choiceQuestion = (instructions: string): Question => ({
  type: "choice",
  instructions,
  criteria: {
    better: "The change makes this better.",
    same: "The change does not alter this.",
    worse: "The change makes this worse.",
  },
})

/** The union of the measured regions, or the whole image when there is none. */
function unionOf(regions: StoryInput["regions"]): Box {
  if (!regions.length) return { x: 0, y: 0, width: 1, height: 1 }
  const left = Math.min(...regions.map(({ box }) => box.x))
  const top = Math.min(...regions.map(({ box }) => box.y))
  const right = Math.max(...regions.map(({ box }) => box.x + box.width))
  const bottom = Math.max(...regions.map(({ box }) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Judge one story with Jev. The key comes from `MODEL_PROVIDER_API_KEY` and
 * the OpenRouter API base from `MODEL_PROVIDER_URL`. The verdict says
 * `regression` when Jev finds a
 * defect or a worse area or quality with a probability of 0.5 or more, and
 * `unsure` when a probability is from 0.2 up to 0.5 or when a question has no
 * answer. Else nothing got worse: the verdict is `intended` when a brief or a
 * source diff explains the change, and `unsure` when none does (the rule of
 * `parseVerdict`). Jev gives no text, so `observations` is empty and each
 * finding has an empty `evidence`. A 400 or 413 answer gives `unsure` with
 * the error. An image that is not a PNG, or that has a side under 280 or over
 * 1568 px, gives `unsure` with the error and no call: the adapter does not
 * pad or scale images. Another failure throws.
 *
 * The request sends the header `TypeSafe-Danger-Zone-Images: true`. TypeSafe
 * requires it for an image or a Box question. The OpenRouter docs do not
 * mention it, and no real call has confirmed that OpenRouter needs it.
 */
export async function judgeWithJev(story: StoryInput): Promise<Verdict> {
  const apiKey = process.env.MODEL_PROVIDER_API_KEY
  if (!apiKey)
    throw new Error("Set MODEL_PROVIDER_API_KEY (the OpenRouter key).")
  const base = process.env.MODEL_PROVIDER_URL || "https://openrouter.ai/api/v1"
  const requestedModel = "typesafe/jev-1.14"

  const unsure = (
    error: string,
    latencyMs = 0,
    model = requestedModel,
  ): Verdict => ({
    storyId: story.storyId,
    observations: [],
    verdict: "unsure",
    severity: "none",
    confidence: 0,
    summary: "The Jev filter gave no usable answer.",
    qualities: [],
    findings: [],
    model,
    costUsd: null,
    latencyMs,
    error,
  })
  const prepared: (StoryImage & { url: string })[] = []
  for (const image of story.images) {
    const read = await readImage(image)
    if ("problem" in read) return unsure(read.problem)
    prepared.push({ ...image, url: read.url })
  }
  // The box is asked on the full after image, else on the locator. A
  // [before | after] strip does not map to the after image.
  const boxIndex = (["after", "locator"] as const)
    .map((role) => prepared.findIndex((image) => image.role === role))
    .find((index) => index >= 0)

  const askedQualities = qualities.filter(
    ({ pageOnly }) => story.scope === "page" || !pageOnly,
  )
  const questions: Record<string, Question> = {
    defect: {
      type: "noul",
      instructions:
        "Is there a visible defect in a measured region of the after image, one that breaks a rule of the rubric?",
    },
  }
  for (const { id, name, definition } of areas)
    questions[`area.${id}`] = choiceQuestion(
      `Area: ${name}. ${definition} Does the change make this area better, the same or worse? Judge only the measured regions.`,
    )
  for (const { id, name, definition } of askedQualities)
    questions[`quality.${id}`] = choiceQuestion(
      `Quality: ${name}. ${definition} Does the change make this quality better, the same or worse? Judge only the measured regions.`,
    )
  if (boxIndex !== undefined)
    questions["defect-box"] = {
      type: "box",
      instructions: `the visible defect in Image ${boxIndex + 1} (${prepared[boxIndex]?.role})`,
    }

  const state = [
    buildPrompt(story).story,
    ...prepared.flatMap(({ role, url }, index) => [
      `Image ${index + 1} (${role}):`,
      { type: "image_url", image_url: { url } },
    ]),
  ]

  const started = performance.now()
  const response = await fetch(
    new URL("../alpha/decisions", `${base.replace(/\/+$/, "")}/`),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "typesafe-danger-zone-images": "true",
      },
      body: JSON.stringify({ model: requestedModel, state, questions }),
      signal: AbortSignal.timeout(120_000),
    },
  )
  const latencyMs = Math.round(performance.now() - started)
  if (!response.ok) {
    const error = `Jev answered ${response.status}: ${await response.text()}`
    if (response.status === 400 || response.status === 413)
      return unsure(error, latencyMs)
    throw new Error(error)
  }
  const parsed = z
    .object({
      model: z.string(),
      answers: z.record(z.string(), z.unknown()),
      usage: z.object({ cost: z.number().min(0).optional() }).optional(),
    })
    .safeParse(await response.json())
  if (!parsed.success)
    return unsure(
      `The Jev response does not match the schema:\n${z.prettifyError(parsed.error)}`,
      latencyMs,
    )
  const { answers, model, usage } = parsed.data

  const choiceAnswer = z.object({
    probabilities: z.object({
      better: z.number().min(0).max(1),
      same: z.number().min(0).max(1),
      worse: z.number().min(0).max(1),
    }),
  })
  const deltaOf = (name: string) => {
    const answer = choiceAnswer.safeParse(answers[name])
    if (!answer.success) return undefined
    const { probabilities } = answer.data
    const delta = (["better", "same", "worse"] as const).reduce((best, next) =>
      probabilities[next] > probabilities[best] ? next : best,
    )
    return {
      delta,
      probability: probabilities[delta],
      worse: probabilities.worse,
    }
  }
  const areaResults = areas.flatMap((area) => {
    const result = deltaOf(`area.${area.id}`)
    return result ? [{ area, ...result }] : []
  })
  const qualityResults = askedQualities.flatMap(({ id }) => {
    const result = deltaOf(`quality.${id}`)
    return result ? [{ id, ...result }] : []
  })
  const defect = z
    .object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })
    .safeParse(answers["defect"])
  const defectProbability = defect.success ? defect.data.noul : 0
  const unanswered =
    (defect.success ? 0 : 1) +
    (areas.length - areaResults.length) +
    (askedQualities.length - qualityResults.length)

  const strongest = Math.max(
    defectProbability,
    ...areaResults.map(({ worse }) => worse),
    ...qualityResults.map(({ worse }) => worse),
  )
  const flagged = strongest >= 0.5
  const doubtful = unanswered > 0 || strongest >= 0.2

  // A box is in fractions of the sent image, which is the after image or the
  // locator (an overview of it).
  const drawn = z
    .object({
      type: z.literal("box"),
      box: z.object({
        top: z.number(),
        bottom: z.number(),
        left: z.number(),
        right: z.number(),
      }),
    })
    .safeParse(answers["defect-box"])
  let region = unionOf(story.regions)
  if (drawn.success) {
    const { top, bottom, left, right } = drawn.data.box
    const [x, y, x2, y2] = [
      clamp(left),
      clamp(top),
      clamp(right),
      clamp(bottom),
    ]
    if (x2 > x && y2 > y) region = { x, y, width: x2 - x, height: y2 - y }
  }

  // Each worse area is a finding. A flagged defect with no worse area gets a
  // finding for the area that is the most likely to be worse, so that the
  // region is not lost.
  const worseAreas = areaResults.filter(
    ({ delta, worse }) => delta === "worse" && worse >= 0.5,
  )
  const findingAreas =
    flagged && !worseAreas.length && areaResults.length
      ? [
          areaResults.reduce((best, next) =>
            next.worse > best.worse ? next : best,
          ),
        ]
      : worseAreas
  // Without an answered area, a flagged defect has no kind to name: unsure.
  const regression = flagged && findingAreas.length > 0
  const worseLabels = [
    ...worseAreas.map(({ area, worse }) => `${area.id} ${worse.toFixed(2)}`),
    ...qualityResults
      .filter(({ delta, worse }) => delta === "worse" && worse >= 0.5)
      .map(({ id, worse }) => `${id} ${worse.toFixed(2)}`),
  ]
  const summary = regression
    ? `Jev filter: defect ${defectProbability.toFixed(2)}; worse: ${worseLabels.join(", ") || "none"}.`
    : flagged
      ? "Jev filter flagged a problem, but no area question has an answer to place it."
      : unanswered
        ? `Jev filter left ${unanswered} questions without an answer.`
        : doubtful
          ? `Jev filter is not sure: the strongest worse probability is ${strongest.toFixed(2)}.`
          : `Jev filter found nothing worse: defect ${defectProbability.toFixed(2)}.`

  // `parseVerdict` checks the judgement and applies the rules of the prompt.
  return parseVerdict(
    JSON.stringify({
      observations: [],
      verdict: regression
        ? "regression"
        : doubtful || flagged
          ? "unsure"
          : "intended",
      severity: regression ? (strongest >= 0.8 ? "major" : "minor") : "none",
      confidence: regression
        ? strongest
        : unanswered || flagged
          ? 0
          : 1 - strongest,
      summary,
      qualities: qualityResults.map(({ id, delta, probability }) => ({
        name: id,
        delta,
        confidence: probability,
      })),
      findings: findingAreas.map(({ area }) => ({
        kind: area.id,
        region,
        evidence: "",
        rubricRef: `${area.sources[0].file} › ${area.sources[0].section}`,
        explainedByBrief: false,
        suggestion: null,
      })),
    }),
    story,
    { model, costUsd: usage?.cost ?? null, latencyMs },
  )
}
