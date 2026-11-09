import { readFile } from "node:fs/promises"
import { extname } from "node:path"

import { prepareImage } from "../prepare.ts"
import { buildNewPrompt, buildPrompt, type Prompt } from "../prompt.ts"
import type { NewStoryInput, StoryInput } from "../story.ts"
import {
  judgementJsonSchema,
  newJudgementJsonSchema,
  parseNewVerdict,
  parseVerdict,
  type RunFacts,
  type Verdict,
} from "../verdict.ts"

/**
 * Map a `provider/model` id to an OpenRouter id. OpenRouter writes Claude
 * versions with dots and has no date suffix: `anthropic/claude-sonnet-4-5-20250929`
 * becomes `anthropic/claude-sonnet-4.5`. Other ids pass as they are.
 */
export function openRouterModelId(model: string): string {
  const id = model.replace(/^openrouter\//, "")
  const [provider, ...rest] = id.split("/")
  const name = rest.join("/")
  if (!provider || !name)
    throw new Error(`Model "${model}" must look like provider/model.`)
  if (provider !== "anthropic") return id
  return `anthropic/${name
    .replace(/-\d{8}$/, "")
    .replace(/(\d+)-(\d+)(?=$|-)/, "$1.$2")}`
}

/** USD for one token of input and of output. */
type Price = { input: number; output: number }

/**
 * The prices of the given OpenRouter model ids, from `GET {baseUrl}/models`
 * (no key needed). A model without a listed price, or a list that does not
 * load, has no entry: its cost is then unknown, not zero.
 */
export async function openRouterPrices(
  baseUrl: string,
  ids: readonly string[],
): Promise<Map<string, Price>> {
  const prices = new Map<string, Price>()
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return prices
    const { data } = (await response.json()) as {
      data?: {
        id: string
        pricing?: { prompt?: string; completion?: string }
      }[]
    }
    for (const model of data ?? []) {
      const input = Number(model.pricing?.prompt)
      const output = Number(model.pricing?.completion)
      if (
        ids.includes(model.id) &&
        Number.isFinite(input) &&
        Number.isFinite(output)
      )
        prices.set(model.id, { input, output })
    }
  } catch {
    // No price list: the cost stays unknown.
  }
  return prices
}

/** The cost in USD of the tokens of one model, or undefined without a price. */
export function usageCost(
  tokens: { inputTokens: number; outputTokens: number },
  price: Price | undefined,
): number | undefined {
  if (!price) return undefined
  return tokens.inputTokens * price.input + tokens.outputTokens * price.output
}

const imagePart = async (path: string) => {
  const extension = extname(path).toLowerCase()
  const mimeType = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  }[extension]
  if (!mimeType)
    throw new Error(
      `Image "${path}" has type "${extension.slice(1)}". Use png, jpg or webp.`,
    )
  // A PNG is brought within the side limits of the vision models.
  const { png } = prepareImage(await readFile(path))
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${Buffer.from(png).toString("base64")}`,
    },
  }
}

/**
 * Judge one story with a vision model through OpenRouter. `model` is a
 * `provider/model` id. The key comes from `MODEL_PROVIDER_API_KEY` and the
 * base URL from `MODEL_PROVIDER_URL` (default: OpenRouter). The request sends
 * the cached prefix, the story text, then the images as data URLs, asks for the
 * critic JSON Schema, and denies data collection by the provider. A PNG with
 * a side under 280 or over 1568 px is padded or scaled first (see
 * `prepareImage`).
 *
 * The verdict carries the measured latency and the cost from `usage.cost`
 * (`null` when the response has none). A reply that is not usable gives the
 * verdict `unsure` with `error`. A failed call (no key, an HTTP error, a
 * response without a message) throws: the caller can retry it.
 */
export async function judgeWithOpenRouter(
  story: StoryInput,
  model: string,
  env: Record<string, string | undefined>,
): Promise<Verdict> {
  const { content, run } = await complete(
    buildPrompt(story),
    judgementJsonSchema,
    model,
    env,
  )
  return parseVerdict(content, story, run)
}

/**
 * Judge the new screenshots of one story on their own against the rubric,
 * in one call, as `judgeWithOpenRouter` judges a change.
 */
export async function judgeNewWithOpenRouter(
  story: NewStoryInput,
  model: string,
  env: Record<string, string | undefined>,
): Promise<Verdict> {
  const { content, run } = await complete(
    buildNewPrompt(story),
    newJudgementJsonSchema,
    model,
    env,
  )
  return parseNewVerdict(content, story, run)
}

/** One chat call: the reply text and its run facts, or it throws. */
async function complete(
  prompt: Prompt,
  schema: typeof judgementJsonSchema | typeof newJudgementJsonSchema,
  model: string,
  env: Record<string, string | undefined>,
): Promise<{ content: string; run: RunFacts }> {
  const apiKey = env.MODEL_PROVIDER_API_KEY
  if (!apiKey)
    throw new Error(
      `Set MODEL_PROVIDER_API_KEY (the OpenRouter key) for ${model}.`,
    )
  const baseUrl = (
    env.MODEL_PROVIDER_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "")
  const images = await Promise.all(
    prompt.images.map(({ path }) => imagePart(path)),
  )

  const started = performance.now()
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: openRouterModelId(model),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt.prefix,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: prompt.story },
            ...images,
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "visual_verdict",
          strict: true,
          schema,
        },
      },
      provider: { data_collection: "deny" },
    }),
  })
  const text = await response.text()
  const latencyMs = performance.now() - started

  let body: {
    choices?: { message?: { content?: string | null } }[]
    usage?: { cost?: number }
    error?: { message?: string }
  } = {}
  try {
    body = JSON.parse(text)
  } catch {
    // The status and the text below name the failure.
  }
  if (!response.ok)
    throw new Error(
      `OpenRouter answered ${response.status} for ${model}: ${
        body.error?.message ?? text.slice(0, 200)
      }`,
    )
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== "string")
    throw new Error(
      `OpenRouter returned no message for ${model}${
        body.error?.message ? `: ${body.error.message}` : "."
      }`,
    )

  return {
    content,
    run: {
      model,
      costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null,
      latencyMs,
    },
  }
}
