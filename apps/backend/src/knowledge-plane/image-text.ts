// The text of an image for the knowledge plane (ADR-068 decision 6). A
// vision model reads the image and returns a structured reading: a
// description, the text in the image, and the graph or the sequence of a
// diagram. Our code renders the Mermaid from that reading, so the syntax is
// always valid and the same reading always gives the same text. The model
// writes no Mermaid itself.
//
// The request goes to OpenRouter with `zdr: true` and
// `data_collection: "deny"`, and with no provider pin: OpenRouter can fall
// back to another ZDR endpoint of a model, and to the next model of
// `IMAGE_TEXT_MODELS` (the CTO, 2026-11-20). The projection keeps each
// reading in a cache by blob SHA (`imageTexts`), so a rebuild calls no model.
import { z } from "zod"

import { assertNotInOrgDbContext } from "../db/client.js"
import type {
  KnowledgeScope,
  KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import { mapPool } from "../lib/mapPool.js"
import { parseJson } from "../lib/parseJson.js"
import {
  TransientHttpError,
  withTransientHttpRetry,
} from "../lib/withTransientHttpRetry.js"
import { gatewayCost } from "../observability/gatewayCost.js"
import {
  openRouterSettings,
  ZDR_PROVIDER,
} from "../retrieval/services/modelProvider.js"

/**
 * The version of the prompt and the reading schema. A change of either
 * changes the text of an image, so the cache key of the text holds it.
 */
export const IMAGE_TEXT_PROMPT_VERSION = 1

/**
 * The vision models, in fallback order (the lead, 2026-11-20, from the
 * vision eval: GPT-6.1 Terra was the cheapest and the fastest, with no
 * error). Each model has ZDR endpoints of one provider only, so the second
 * model is the fallback (OpenRouter `models`). The evals of ADR-069 can
 * change the list: a change of it changes only the models of new readings,
 * because a cached reading keeps the model that answered.
 */
export const IMAGE_TEXT_MODELS = [
  "openai/gpt-6.1-terra",
  "google/gemini-3.8-flash",
] as const

// scope-allow: the prompt stays beside its version, IMAGE_TEXT_PROMPT_VERSION.
const PROMPT = `You convert one image into text for a search index. Return JSON that matches the schema.

description: two to four sentences that say what the image shows and what it is for.
text: every legible word in the image, in reading order, one line for each block of text. Copy the text exactly. Do not translate or correct it.
diagram: fill it when the image is a diagram whose boxes, shapes or lifelines are connected by lines or arrows (architecture, network, data flow, flowchart, state machine, sequence). Else set kind "none" and leave all of its lists empty.

For a graph diagram (kind "graph"):
1. groups: each container, boundary, cluster, lane or zone that holds other shapes, with its exact title. parent is the id of the group that holds it, or "".
2. nodes: every shape that has a label, also the shapes inside groups and the icons with a caption. Use the exact label. group is the id of the innermost group that holds the node, or "". Give each node a short unique id.
3. edges: go through the nodes one at a time. For each node, list every line or arrow that starts at it. from is the node at the tail and to is the node at the arrowhead. Follow each line to its end, also where it bends or crosses another line. label is the exact text on the line, or "". arrow is "forward" for one arrowhead, "both" for arrowheads at both ends, and "none" for a line with no arrowhead. A line that ends at the border of a group connects to the id of the group.
4. direction: the main direction of the flow: "LR" (left to right), "RL", "TB" (top to bottom) or "BT".
Then count again: each line or arrow of the image is in edges exactly once.

For a sequence diagram (kind "sequence"):
1. participants: the lifelines from left to right, with their exact labels.
2. messages: every arrow between lifelines, from top to bottom, in that order. from is the lifeline at the tail and to is the lifeline at the arrowhead. A message to the same lifeline has the same from and to. label is the exact text. reply is true for a dashed return arrow.

Do not add shapes, lines or text that are not in the image. Leave the lists of the other diagram kind empty.`

// Strict at each level: the structured output of the model needs
// `additionalProperties: false`. No field is nullable: an empty string means
// "none", because some providers do not take a type list.
const readingSchema = z.strictObject({
  description: z.string(),
  text: z.string(),
  diagram: z.strictObject({
    kind: z.enum(["none", "graph", "sequence"]),
    direction: z.enum(["TB", "LR", "BT", "RL"]),
    groups: z.array(
      z.strictObject({ id: z.string(), label: z.string(), parent: z.string() }),
    ),
    nodes: z.array(
      z.strictObject({ id: z.string(), label: z.string(), group: z.string() }),
    ),
    edges: z.array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        label: z.string(),
        arrow: z.enum(["forward", "both", "none"]),
      }),
    ),
    participants: z.array(
      z.strictObject({ id: z.string(), label: z.string() }),
    ),
    messages: z.array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        label: z.string(),
        reply: z.boolean(),
      }),
    ),
  }),
})

/** What the vision model reads in one image. */
export type ImageReading = z.infer<typeof readingSchema>

/** A label as Mermaid text: one line, with its special characters as entities. */
const escape = (label: string) =>
  label
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /[#";]/g,
      (char) => `#${char === '"' ? "quot" : char.charCodeAt(0)};`,
    )

type Diagram = ImageReading["diagram"]

/** The first item of each id, in order. A repeated id names the first item. */
export const firstOfEachId = <T extends { id: string }>(
  items: readonly T[],
): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id))
}

function renderGraph(diagram: Diagram): string {
  const groups = firstOfEachId(diagram.groups)
  const nodes = firstOfEachId(diagram.nodes)
  const groupIds = new Map(groups.map((group, i) => [group.id, `g${i + 1}`]))
  const nodeIds = new Map(nodes.map((node, i) => [node.id, `n${i + 1}`]))
  const parentOf = new Map(groups.map((group) => [group.id, group.parent]))
  // A parent that does not exist, or that is part of a cycle, puts the
  // group at the top level.
  const validParent = (id: string): string => {
    const parent = parentOf.get(id) ?? ""
    const seen = new Set([id])
    for (let at = parent; at; at = parentOf.get(at) ?? "") {
      if (!parentOf.has(at) || seen.has(at)) return ""
      seen.add(at)
    }
    return parent
  }
  const lines = [`flowchart ${diagram.direction}`]
  const write = (parent: string, depth: number) => {
    const pad = "  ".repeat(depth)
    for (const node of nodes)
      if ((parentOf.has(node.group) ? node.group : "") === parent)
        lines.push(`${pad}${nodeIds.get(node.id)}["${escape(node.label)}"]`)
    for (const group of groups)
      if (validParent(group.id) === parent) {
        lines.push(
          `${pad}subgraph ${groupIds.get(group.id)}["${escape(group.label)}"]`,
        )
        write(group.id, depth + 1)
        lines.push(`${pad}end`)
      }
  }
  write("", 1)
  const ref = (id: string) => nodeIds.get(id) ?? groupIds.get(id)
  const arrows = { forward: "-->", both: "<-->", none: "---" }
  for (const edge of diagram.edges) {
    const from = ref(edge.from)
    const to = ref(edge.to)
    // An edge to an id that the reading does not hold has no place in the
    // diagram.
    if (!from || !to) continue
    const label = escape(edge.label)
    lines.push(
      `  ${from} ${arrows[edge.arrow]}${label ? `|"${label}"|` : ""} ${to}`,
    )
  }
  return lines.join("\n")
}

function renderSequence(diagram: Diagram): string {
  const participants = firstOfEachId(diagram.participants)
  const ids = new Map(participants.map((item, i) => [item.id, `p${i + 1}`]))
  const lines = ["sequenceDiagram"]
  for (const participant of participants)
    lines.push(
      `  participant ${ids.get(participant.id)} as ${escape(participant.label)}`,
    )
  for (const message of diagram.messages) {
    const from = ids.get(message.from)
    const to = ids.get(message.to)
    if (!from || !to) continue
    lines.push(
      `  ${from}${message.reply ? "-->>" : "->>"}${to}: ${escape(message.label)}`,
    )
  }
  return lines.join("\n")
}

/**
 * The Mermaid of a diagram, or null for an image that is not a diagram. Our
 * own ids (`n1`, `g1`, `p1`) replace the ids of the model, in the order of
 * the reading.
 */
export function renderMermaid(diagram: Diagram): string | null {
  if (diagram.kind === "graph") return renderGraph(diagram)
  if (diagram.kind === "sequence") return renderSequence(diagram)
  return null
}

/** The text that the projection indexes for an image. */
export function imageText(reading: ImageReading): string {
  const parts = [reading.description.trim()]
  if (reading.text.trim())
    parts.push(`Text in the image:\n${reading.text.trim()}`)
  const mermaid = renderMermaid(reading.diagram)
  if (mermaid) parts.push(`\`\`\`mermaid\n${mermaid}\n\`\`\``)
  return `${parts.filter(Boolean).join("\n\n")}\n`
}

/**
 * The failure of one vision call. The message holds no request or response
 * text, because both can be customer content.
 * - `config`: the backend model settings cannot reach OpenRouter.
 * - `network`: no answer (DNS, connection, TLS), after the retries.
 * - `timeout`: no full answer within the time limit.
 * - `http`: an error status, after the retries of a 429 or a 5xx.
 * - `invalid-answer`: the answer does not match the reading schema.
 */
export class VisionError extends Error {
  override readonly name = "VisionError"
  constructor(
    readonly kind: "config" | "network" | "timeout" | "http" | "invalid-answer",
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** One reading, and the call that made it. */
type ImageReadResult = {
  reading: ImageReading
  /** The model that answered (the `model` of the answer). */
  model: string
  /** The upstream provider that answered. */
  provider: string | null
  /** The cost that OpenRouter reports, or null when the answer has none. */
  costUsd: number | null
}

/**
 * Read one image with the first vision model of `models` that answers
 * (OpenRouter `models` fallback). The key and the base URL
 * come from the backend model settings, which must point at OpenRouter
 * (`openRouterSettings`). A 429, a 5xx and a network error retry, up to
 * three attempts. A failure throws a `VisionError`. The call must not run
 * inside an org database transaction.
 */
export async function readImage(
  image: { bytes: Buffer; mimeType: string },
  options: {
    /**
     * The OpenRouter model ids, in fallback order. Each must take an image
     * and a JSON schema.
     */
    models: readonly string[]
    /** The first backoff of a retry. */
    backoffMs?: number
  },
): Promise<ImageReadResult> {
  assertNotInOrgDbContext()
  const settings = openRouterSettings()
  if (!settings)
    throw new VisionError(
      "config",
      "The vision model needs MODEL_PROVIDER openrouter or openai-like, an OpenRouter MODEL_PROVIDER_URL, and MODEL_PROVIDER_API_KEY.",
    )
  const body = JSON.stringify({
    models: options.models,
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "image_reading",
        strict: true,
        schema: z.toJSONSchema(readingSchema),
      },
    },
    // Each ZDR endpoint of a model that takes the JSON schema can answer.
    // The OpenRouter docs do not say that this block holds for each model
    // of `models`; the knowledge probe checks it with real calls.
    provider: { ...ZDR_PROVIDER, require_parameters: true },
  })
  try {
    return await withTransientHttpRetry(
      () =>
        send(
          `${settings.base.replace(/\/+$/, "")}/chat/completions`,
          settings.apiKey,
          body,
        ),
      { retries: 2, baseDelayMs: options.backoffMs ?? 2_000 },
    )
  } catch (error) {
    if (error instanceof VisionError) throw error
    if (error instanceof TransientHttpError)
      throw new VisionError(
        "http",
        `The vision model answered ${error.status}.`,
        error.status,
      )
    if (error instanceof Error && error.name === "TimeoutError")
      throw new VisionError(
        "timeout",
        "The vision model did not answer in time.",
      )
    throw new VisionError("network", "The vision model could not be reached.")
  }
}

const answerSchema = z.object({
  model: z.string(),
  provider: z.string().optional(),
  usage: z.unknown().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.unknown() }) }))
    .min(1),
})

async function send(
  url: string,
  apiKey: string,
  body: string,
): Promise<ImageReadResult> {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(180_000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body,
  })
  if (response.status === 429 || response.status >= 500)
    throw new TransientHttpError(
      `The vision model answered ${response.status}.`,
      response.status,
    )
  if (!response.ok)
    throw new VisionError(
      "http",
      `The vision model answered ${response.status}.`,
      response.status,
    )
  // A network error while the body arrives throws here, and it retries.
  const answer = answerSchema.safeParse(parseJson(await response.text()))
  const content = answer.data?.choices[0]?.message.content
  const reading = readingSchema.safeParse(
    typeof content === "string" ? parseJson(content) : null,
  )
  if (!answer.success || !reading.success)
    throw new VisionError(
      "invalid-answer",
      "The vision model gave an answer out of the reading schema.",
    )
  return {
    reading: reading.data,
    model: answer.data.model,
    provider: answer.data.provider ?? null,
    costUsd: gatewayCost(answer.data.usage) ?? null,
  }
}

/** The image work of one run, for its metrics. */
export type ImageTextCounter = {
  /** Images whose reading came from the cache (`image_texts`). */
  hits: number
  /** Images that went to the vision model. */
  misses: number
  /** Images that got no reading: their documents are `failed`. */
  failures: number
  /** The cost of the vision calls of the run. */
  costUsd: number
}

/** One image of a run, by the SHA of its Git blob. */
type ImageInput = {
  blobSha: string
  image: { bytes: Buffer; mimeType: string }
  /** The text of the labels of an SVG, which the converter takes from it. */
  labels?: string
}

/**
 * The text of each image of `images`, by blob SHA, or the error of a reading
 * that failed. The reading of a blob comes from the cache (`image_texts`)
 * when a model of `IMAGE_TEXT_MODELS` has read it with this prompt
 * version. Else the vision model reads it, and the cache keeps the reading
 * under the model that answered, at once, so that a run that stops later
 * does not pay for it again. Thus a rebuild makes no vision call, and the
 * same bytes give the same text.
 */
export async function imageTexts(input: {
  store: Pick<KnowledgeStore, "readImageTexts" | "writeImageTexts">
  scope: KnowledgeScope
  images: ImageInput[]
  counter: ImageTextCounter
  /** The first backoff of a retry of the vision call. */
  backoffMs?: number
}): Promise<Map<string, { text: string } | { error: string }>> {
  const results = new Map<string, { text: string } | { error: string }>()
  const cached = await input.store.readImageTexts(
    input.scope,
    input.images.map((image) => image.blobSha),
    IMAGE_TEXT_MODELS,
    IMAGE_TEXT_PROMPT_VERSION,
  )
  const withLabels = (reading: ImageReading, labels?: string) =>
    labels?.trim()
      ? `${imageText(reading)}\nLabels in the file:\n${labels.trim()}\n`
      : imageText(reading)
  const misses: ImageInput[] = []
  const seen = new Set<string>()
  for (const image of input.images) {
    const { blobSha, labels } = image
    if (seen.has(blobSha)) continue
    seen.add(blobSha)
    const stored = cached.get(blobSha)
    const reading = stored
      ? readingSchema.safeParse(parseJson(stored.reading))
      : null
    if (reading?.success) {
      input.counter.hits++
      results.set(blobSha, { text: withLabels(reading.data, labels) })
    } else misses.push(image)
  }
  // A few calls at a time: a first rebuild of a Workspace with many images
  // waits on the model, not on the order.
  await mapPool(misses, 4, async ({ blobSha, image, labels }) => {
    input.counter.misses++
    try {
      const read = await readImage(image, {
        models: IMAGE_TEXT_MODELS,
        backoffMs: input.backoffMs,
      })
      input.counter.costUsd += read.costUsd ?? 0
      await input.store.writeImageTexts(input.scope, [
        {
          blobSha,
          model: read.model,
          promptVersion: IMAGE_TEXT_PROMPT_VERSION,
          reading: JSON.stringify(read.reading),
        },
      ])
      results.set(blobSha, { text: withLabels(read.reading, labels) })
    } catch (error) {
      // A content failure makes a `failed` document: an answer out of the
      // schema, or a refusal of the image itself (400, 413, 415, 422). Each
      // other error stops the run, as an infrastructure error does (ADR-067
      // decision 8): an outage (network, timeout, 429, 5xx), the settings or
      // the account (401, 402, 403), no endpoint for the model (404), and a
      // store error. The retry reads the image again.
      if (
        !(error instanceof VisionError) ||
        !(
          error.kind === "invalid-answer" ||
          (error.kind === "http" &&
            [400, 413, 415, 422].includes(error.status ?? 0))
        )
      )
        throw error
      input.counter.failures++
      results.set(blobSha, { error: error.message })
    }
  })
  return results
}
