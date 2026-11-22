import { openRouterModelId } from "@ctxpipe/visual-review"
import { z } from "zod"

import { gatewayRoutingError } from "../../src/observability/gatewayError.js"
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
 * What OpenRouter said about a call that a moderation check refused (HTTP
 * 403 with a moderation category). Only what cannot echo the input: the
 * error code, the category names and the provider (short identifiers only),
 * and the message only when it is a fixed routing text of OpenRouter.
 */
export const refusalRecordSchema = z.object({
  code: z.union([z.number(), z.string()]).nullable(),
  reasons: z.array(z.string()),
  provider: z.string().optional(),
  message: z.string().optional(),
})
export type Refusal = z.infer<typeof refusalRecordSchema>

/** A moderation check of OpenRouter refused the call (HTTP 403). */
export class RefusedError extends Error {
  constructor(
    model: string,
    readonly refusal: Refusal,
  ) {
    super(
      `OpenRouter refused the call for ${model} (403${refusal.reasons.length > 0 ? `: ${refusal.reasons.join(", ")}` : ""}).`,
    )
  }
}

/**
 * The budget of the OpenRouter workspace of the key is spent (HTTP 403): no
 * call can go out until it resets. It is no fault of one input.
 */
export class BudgetExceededError extends Error {
  constructor(
    model: string,
    readonly budget: { limitUsd: number; resetsAt?: string },
  ) {
    super(
      `The OpenRouter workspace budget of $${budget.limitUsd.toFixed(2)} is spent (403 for ${model})${budget.resetsAt ? `; it resets ${budget.resetsAt}` : ""}.`,
    )
  }
}

const forbiddenBodySchema = z.object({
  error: z.object({
    code: z.union([z.number(), z.string()]).nullish(),
    message: z.string().optional(),
    metadata: z
      .object({
        reasons: z.array(z.string()).optional(),
        provider_name: z.string().optional(),
      })
      .partial()
      .nullish(),
  }),
})

/** A short identifier (a category, a provider or a time), never free text. */
const identifier = (value: string | undefined) =>
  value && /^[\w ./:+-]{1,40}$/.test(value) ? value : undefined

/**
 * The error of a 403 answer body of a call for `model`: the spent budget of
 * the workspace (its fixed text: "Workspace daily budget of $N exceeded …
 * resets …"), a moderation refusal (a moderation category), or else a
 * plain error with no text of the answer.
 */
function forbiddenError(body: string, model: string): Error {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = undefined
  }
  const error = forbiddenBodySchema.safeParse(json).data?.error
  const text = error?.message ?? ""
  const budget = /^Workspace daily budget of \$(\d+(?:\.\d+)?) exceeded/.exec(
    text,
  )
  if (budget) {
    const resetsAt = identifier(
      /resets (?:at |on )?([^;,]+?)\.?$/.exec(text)?.[1],
    )
    return new BudgetExceededError(model, {
      limitUsd: Number(budget[1]),
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  const reasons = (error?.metadata?.reasons ?? []).flatMap(
    (reason) => identifier(reason) ?? [],
  )
  if (reasons.length === 0)
    return new Error(`OpenRouter answered 403 for ${model}.`)
  const provider = identifier(error?.metadata?.provider_name)
  const message = gatewayRoutingError(body, openRouterModelId(model))
  return new RefusedError(model, {
    code:
      typeof error?.code === "number"
        ? error.code
        : (identifier(error?.code ?? undefined) ?? null),
    reasons,
    ...(provider ? { provider } : {}),
    ...(message ? { message } : {}),
  })
}

/**
 * The seconds of a `Retry-After` header, or null when it gives no number of
 * seconds.
 */
function retryAfterSeconds(value: string | null): number | null {
  const seconds = Number(value ?? "")
  return value && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : null
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
  if (response.status === 403)
    throw forbiddenError(await response.text(), input.model)
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
