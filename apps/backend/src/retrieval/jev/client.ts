// The Jev client of the backend (ADR-068). Jev (TypeSafe) answers typed
// questions with probabilities through the OpenRouter Decisions API. The
// request shape is the same as in the visual critic
// (`packages/visual-review/src/adapters/jev.ts`), but this client also pins
// the upstream provider (ADR-068 decision 7), because it sends customer
// content.
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { z } from "zod"

import { gatewayCost } from "../../observability/gatewayCost.js"

/** The Jev model of the OpenRouter Decisions API. */
const JEV_MODEL = "typesafe/jev-1.14"
/**
 * The OpenRouter slug of the only upstream provider that can serve
 * `JEV_MODEL`. Each request pins it, with no fallback (ADR-068 decision 7).
 */
const JEV_PROVIDER = "typesafe"

/** The state of a decisions request: text, and each image as a data URL. */
export type JevState = (
  | string
  | { type: "image_url"; image_url: { url: string } }
)[]

/** A yes/no question. Jev answers it with a probability of yes. */
export type JevQuestion = { type: "noul"; instructions: string }

/**
 * The failure of one Jev call. `timeout`: no answer within the time limit.
 * `http`: the endpoint answered with an error status. `invalid-answer`: the
 * response, or the answer to a question, does not match the schema. The
 * message holds no request or response text, because that can be customer
 * content.
 */
export class JevError extends Error {
  override readonly name = "JevError"
  constructor(
    readonly kind: "timeout" | "http" | "invalid-answer",
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const settingsSchema = z.object({
  MODEL_PROVIDER_API_KEY: z.string().min(1),
  MODEL_PROVIDER_URL: z.string().url().default("https://openrouter.ai/api/v1"),
})

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.unknown().optional(),
})

const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
})

/**
 * Ask Jev the `questions` about the `state`, in one call. Returns the
 * probability of yes for each question key. The key and the base URL come
 * from `MODEL_PROVIDER_API_KEY` and `MODEL_PROVIDER_URL` (the OpenRouter API
 * base). A failure throws a `JevError`.
 *
 * The call has one span (`jev.decide`) with the model, the cost
 * (`gen_ai.usage.cost`), the latency and the `attributes` of the caller. The
 * span holds no prompt text: the state is customer content.
 */
export async function decideNoul(
  state: JevState,
  questions: Record<string, JevQuestion>,
  options: { timeoutMs: number; attributes: Record<string, number> },
): Promise<Map<string, number>> {
  const settings = settingsSchema.parse({
    MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY || undefined,
    MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL || undefined,
  })
  return trace.getTracer("ctxpipe-llm").startActiveSpan(
    "jev.decide",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "decide",
        "gen_ai.request.model": JEV_MODEL,
        "gen_ai.provider.name": "openrouter",
        "jev.upstream_provider": JEV_PROVIDER,
        "jev.questions": Object.keys(questions).length,
        ...options.attributes,
      },
    },
    async (span) => {
      const started = performance.now()
      try {
        const response = await fetch(
          new URL(
            "../alpha/decisions",
            `${settings.MODEL_PROVIDER_URL.replace(/\/+$/, "")}/`,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${settings.MODEL_PROVIDER_API_KEY}`,
              "content-type": "application/json",
              // TypeSafe requires this header for a state with an image.
              ...(state.some((part) => typeof part !== "string")
                ? { "typesafe-danger-zone-images": "true" }
                : {}),
            },
            body: JSON.stringify({
              model: JEV_MODEL,
              state,
              questions,
              provider: {
                data_collection: "deny",
                order: [JEV_PROVIDER],
                allow_fallbacks: false,
              },
            }),
            signal: AbortSignal.timeout(options.timeoutMs),
          },
        ).catch((error: unknown) => {
          throw error instanceof Error && error.name === "TimeoutError"
            ? new JevError(
                "timeout",
                `Jev gave no answer in ${options.timeoutMs} ms.`,
              )
            : error
        })
        if (!response.ok)
          throw new JevError(
            "http",
            `Jev answered HTTP ${response.status}.`,
            response.status,
          )
        const parsed = responseSchema.safeParse(
          await response.json().catch(() => undefined),
        )
        if (!parsed.success)
          throw new JevError(
            "invalid-answer",
            "The Jev response does not match the schema.",
          )
        const cost = gatewayCost(parsed.data.usage)
        if (cost !== undefined) span.setAttribute("gen_ai.usage.cost", cost)
        const probabilities = new Map<string, number>()
        for (const key of Object.keys(questions)) {
          const answer = noulAnswer.safeParse(parsed.data.answers[key])
          if (!answer.success)
            throw new JevError(
              "invalid-answer",
              `Jev gave no valid yes/no answer to question ${key}.`,
            )
          probabilities.set(key, answer.data.noul)
        }
        return probabilities
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
        if (error instanceof JevError)
          span.setAttribute("jev.error_kind", error.kind)
        throw error
      } finally {
        span.setAttribute(
          "jev.latency_ms",
          Math.round(performance.now() - started),
        )
        span.end()
      }
    },
  )
}
