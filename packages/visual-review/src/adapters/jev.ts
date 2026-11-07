// The Jev adapter: a cheap first filter for the visual critic. Jev (TypeSafe)
// answers typed questions with probabilities and no text, through the
// OpenRouter Decisions API. The adapter asks one question for each area and
// each quality, one question for a visible defect, and one for its region.
// It maps the answers onto the same verdict as the other judges.
import { readFile } from "node:fs/promises"

import sharp from "sharp"
import { z } from "zod"

import { buildPrompt } from "../prompt.ts"
import { areas, qualities } from "../rubric.ts"
import type { Box, StoryInput } from "../story.ts"
import { parseVerdict, type Verdict } from "../verdict.ts"

export type JevOptions = {
  /** Default: `MODEL_PROVIDER_API_KEY`. */
  apiKey?: string
  /** The OpenRouter API base. Default: `MODEL_PROVIDER_URL`, else OpenRouter. */
  baseUrl?: string
  /** Default: `typesafe/jev-1.14`. */
  model?: string
  /**
   * Send the header `TypeSafe-Danger-Zone-Images: true`. TypeSafe requires it
   * for images and Box questions. OpenRouter documents no such header, so
   * this is on by default and can be turned off. Default: true.
   */
  imagesHeader?: boolean
}

const deltas = ["better", "same", "worse"] as const

const choiceAnswer = z.object({
  probabilities: z.object({
    better: z.number().default(0),
    same: z.number().default(0),
    worse: z.number().default(0),
  }),
})
const noulAnswer = z.object({ type: z.literal("noul"), noul: z.number() })
const boxAnswer = z.object({
  type: z.literal("box"),
  box: z.object({
    top: z.number(),
    bottom: z.number(),
    left: z.number(),
    right: z.number(),
  }),
})
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ cost: z.number().min(0).optional() }).optional(),
})

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Prepare one image for Jev: a PNG or JPEG, each side 280 to 1568 px. A long
 * side is scaled down. A short side is padded at the right and at the bottom.
 * `content` is the part of the sent image (0..1) that holds the real image,
 * so that a box on the sent image can be mapped back.
 */
async function prepareImage(path: string) {
  const bytes = await readFile(path)
  const { width = 0, height = 0, format } = await sharp(bytes).metadata()
  const within = (side: number) => side >= 280 && side <= 1568
  if (
    (format === "png" || format === "jpeg") &&
    within(width) &&
    within(height)
  )
    return {
      url: `data:image/${format};base64,${bytes.toString("base64")}`,
      content: { x: 1, y: 1 },
    }
  const scale = Math.min(1, 1568 / Math.max(width, height))
  const newWidth = Math.max(1, Math.round(width * scale))
  const newHeight = Math.max(1, Math.round(height * scale))
  const padded = await sharp(
    await sharp(bytes).resize(newWidth, newHeight).png().toBuffer(),
  )
    .extend({
      right: Math.max(0, 280 - newWidth),
      bottom: Math.max(0, 280 - newHeight),
      extendWith: "copy",
    })
    .png()
    .toBuffer()
  return {
    url: `data:image/png;base64,${padded.toString("base64")}`,
    content: {
      x: newWidth / Math.max(280, newWidth),
      y: newHeight / Math.max(280, newHeight),
    },
  }
}

const choiceQuestion = (instructions: string) => ({
  type: "choice",
  instructions,
  criteria: {
    better: "The change makes this better.",
    same: "The change does not alter this.",
    worse: "The change makes this worse.",
  },
})

const unsure = (
  story: StoryInput,
  error: string,
  latencyMs: number,
  model: string,
): Verdict => ({
  storyId: story.storyId,
  observations: [],
  verdict: "unsure",
  severity: "none",
  confidence: 0,
  summary: "The Jev filter gave no answer.",
  qualities: [],
  findings: [],
  model,
  costUsd: null,
  latencyMs,
  error,
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
 * Judge one story with Jev. The verdict says `regression` when Jev finds a
 * defect or a worse area or quality with a probability of 0.5 or more, and
 * `unsure` when a probability is from 0.2 up to 0.5. Else nothing got worse:
 * the verdict is `intended` when a brief or a source diff explains the change,
 * and `unsure` when none does (the rule of `parseVerdict`). Jev gives no text,
 * so `observations` is empty and each finding has an empty `evidence`. A 400
 * or 413 answer gives `unsure` with the error. Another failure throws.
 */
export async function judgeWithJev(
  story: StoryInput,
  options: JevOptions = {},
): Promise<Verdict> {
  const apiKey = options.apiKey ?? process.env.MODEL_PROVIDER_API_KEY
  if (!apiKey)
    throw new Error("Set MODEL_PROVIDER_API_KEY (the OpenRouter key).")
  const base =
    options.baseUrl ??
    (process.env.MODEL_PROVIDER_URL || "https://openrouter.ai/api/v1")
  const requestedModel = options.model ?? "typesafe/jev-1.14"

  const prepared = await Promise.all(
    story.images.map(async (image) => ({
      ...image,
      ...(await prepareImage(image.path)),
    })),
  )
  // The box is asked on the full after image, else on the locator. A
  // [before | after] strip does not map to the after image.
  const boxImage = (["after", "locator"] as const)
    .map((role) => prepared.findIndex((image) => image.role === role))
    .find((index) => index >= 0)

  const askedQualities = qualities.filter(
    ({ pageOnly }) => story.scope === "page" || !pageOnly,
  )
  const questions: Record<string, unknown> = {
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
  if (boxImage !== undefined)
    questions["defect-box"] = {
      type: "box",
      instructions: `the visible defect in Image ${boxImage + 1} (${prepared[boxImage]!.role})`,
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
        ...(options.imagesHeader === false
          ? {}
          : { "typesafe-danger-zone-images": "true" }),
      },
      body: JSON.stringify({ model: requestedModel, state, questions }),
      signal: AbortSignal.timeout(120_000),
    },
  )
  const latencyMs = Math.round(performance.now() - started)
  if (!response.ok) {
    const text = await response.text()
    const message =
      z
        .object({ error: z.object({ message: z.string() }) })
        .safeParse(safeJson(text)).data?.error.message ?? text
    const error = `Jev answered ${response.status}: ${message}`
    if (response.status === 400 || response.status === 413)
      return unsure(story, error, latencyMs, requestedModel)
    throw new Error(error)
  }
  const parsed = responseSchema.safeParse(await response.json())
  if (!parsed.success)
    return unsure(
      story,
      `The Jev response does not match the schema:\n${z.prettifyError(parsed.error)}`,
      latencyMs,
      requestedModel,
    )
  const { answers, model, usage } = parsed.data

  const deltaOf = (name: string) => {
    const answer = choiceAnswer.safeParse(answers[name])
    if (!answer.success) return undefined
    const { probabilities } = answer.data
    const delta = deltas.reduce((best, next) =>
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
  const defect = noulAnswer.safeParse(answers["defect"])
  const defectProbability = defect.success ? defect.data.noul : 0

  const strongest = Math.max(
    defectProbability,
    ...areaResults.map(({ worse }) => worse),
    ...qualityResults.map(({ worse }) => worse),
  )
  const flagged = strongest >= 0.5
  const doubtful = strongest >= 0.2

  // A box is on the sent image; map it back to the fractions of the real image.
  const drawn = boxAnswer.safeParse(answers["defect-box"])
  const content =
    boxImage === undefined ? undefined : prepared[boxImage]!.content
  let region = unionOf(story.regions)
  if (drawn.success && content) {
    const { top, bottom, left, right } = drawn.data.box
    const x = clamp(left / content.x)
    const y = clamp(top / content.y)
    const x2 = clamp(right / content.x)
    const y2 = clamp(bottom / content.y)
    if (x2 > x && y2 > y) region = { x, y, width: x2 - x, height: y2 - y }
  }

  const worseAreas = flagged
    ? areaResults.filter(
        ({ delta, worse }) => delta === "worse" && worse >= 0.5,
      )
    : []
  const worseLabels = [
    ...worseAreas.map(({ area, worse }) => `${area.id} ${worse.toFixed(2)}`),
    ...qualityResults
      .filter(({ delta, worse }) => delta === "worse" && worse >= 0.5)
      .map(({ id, worse }) => `${id} ${worse.toFixed(2)}`),
  ]
  const summary = flagged
    ? `Jev filter: defect ${defectProbability.toFixed(2)}; worse: ${worseLabels.join(", ") || "none"}.`
    : doubtful
      ? `Jev filter is not sure: the strongest worse probability is ${strongest.toFixed(2)}.`
      : `Jev filter found nothing worse: defect ${defectProbability.toFixed(2)}.`

  // `parseVerdict` checks the judgement and applies the rules of the prompt.
  return parseVerdict(
    JSON.stringify({
      observations: [],
      verdict: flagged ? "regression" : doubtful ? "unsure" : "intended",
      severity: flagged ? (strongest >= 0.8 ? "major" : "minor") : "none",
      confidence: flagged ? strongest : 1 - strongest,
      summary,
      qualities: qualityResults.map(({ id, delta, probability }) => ({
        name: id,
        delta,
        confidence: probability,
      })),
      findings: worseAreas.map(({ area }) => ({
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
