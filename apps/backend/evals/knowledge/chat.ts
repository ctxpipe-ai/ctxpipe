import { openRouterModelId } from "@ctxpipe/visual-review"
import { z } from "zod"

import {
  DEFAULT_OPENROUTER_BASE,
  openRouterProvider,
} from "../../src/retrieval/services/openRouterProvider.js"
import { scrubForModel } from "../../src/retrieval/services/scrubForModel.js"

/** The part of an OpenRouter chat reply that the eval tools read. */
const replySchema = z.object({
  choices: z.array(
    z.object({ message: z.object({ content: z.string().nullish() }) }),
  ),
})

/**
 * The model answered, but not in the schema. A caller can drop that one
 * draft; each other error of a call stops the command.
 */
export class OutOfSchemaError extends Error {}

/**
 * The seconds of a `Retry-After` header (a number of seconds or an HTTP
 * date), or null when it has none.
 */
function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  return Number.isNaN(date)
    ? null
    : Math.max(0, Math.ceil((date - Date.now()) / 1_000))
}

/**
 * Why the eval tools cannot call a model with `env`, or null when they can:
 * the text goes only to the OpenRouter endpoint that the operator chose.
 */
export function modelProviderProblem(
  env: Record<string, string | undefined>,
): string | null {
  const provider = env.MODEL_PROVIDER || "openai-like"
  return ["openrouter", "openai-like"].includes(provider) &&
    env.MODEL_PROVIDER_API_KEY
    ? null
    : "The eval tools need MODEL_PROVIDER openrouter or openai-like, and MODEL_PROVIDER_API_KEY (the OpenRouter key)."
}

/**
 * One chat call of the eval tools (the drafter and the judge panel) through
 * the OpenRouter chat API, with a JSON answer of `schema`. As the Jev client
 * does, the text goes only to the OpenRouter endpoint that the operator
 * chose, with the provider block of ADR-070, and the body is scrubbed.
 */
export async function askJson<T>(input: {
  model: string
  content: string
  schema: z.ZodType<T>
  /** The name of the JSON schema in `response_format`. */
  name: string
  env: Record<string, string | undefined>
}): Promise<T> {
  const problem = modelProviderProblem(input.env)
  if (problem) throw new Error(problem)
  const apiKey = input.env.MODEL_PROVIDER_API_KEY
  const base = (
    input.env.MODEL_PROVIDER_URL || DEFAULT_OPENROUTER_BASE
  ).replace(/\/+$/, "")
  const body = JSON.stringify(
    await scrubForModel({
      model: openRouterModelId(input.model),
      messages: [{ role: "user", content: input.content }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: input.name,
          strict: true,
          schema: z.toJSONSchema(input.schema),
        },
      },
      provider: openRouterProvider(),
    }),
  )
  const send = () =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      // The model gets the scrubbed text, as each model of the product does.
      body,
    })
  let response = await send()
  // A rate limit names its wait: wait that long, at most 3 times and at
  // most 60 s each, then fail. A 429 with no wait fails at once.
  for (let wait = 1; response.status === 429 && wait <= 3; wait++) {
    const seconds = retryAfterSeconds(response.headers.get("retry-after"))
    if (seconds === null || seconds > 60) break
    process.stderr.write(
      `OpenRouter answered 429 for ${input.model}: wait ${wait} of 3, ${seconds} s.\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000))
    response = await send()
  }
  if (!response.ok)
    throw new Error(
      `OpenRouter answered ${response.status} for ${input.model}.`,
    )
  const reply = replySchema.safeParse(await response.json())
  const text = reply.data?.choices[0]?.message.content
  let parsed: unknown
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  const answer = input.schema.safeParse(parsed)
  if (!answer.success)
    throw new OutOfSchemaError(
      `${input.model} gave an answer out of the schema.`,
    )
  return answer.data
}

/** A block of data in a prompt: the model must not read it as instructions. */
export const dataBlock = (text: string) =>
  `<data>${text.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</data>`
