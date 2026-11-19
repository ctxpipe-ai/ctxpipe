// The Jev client of the backend (ADR-068). Jev (TypeSafe) answers typed
// questions with probabilities through the OpenRouter Decisions API. The
// request shape is the same as in the visual critic
// (`packages/visual-review/src/adapters/jev.ts`), but this client also pins
// the upstream provider (ADR-068 decision 7), because it sends customer
// content.
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import { gatewayCost } from "../../observability/gatewayCost.js"
import { DEFAULT_OPENROUTER_BASE } from "../services/modelProvider.js"
import { dropEmptyEnvValues } from "../services/modelTierSpecs.js"

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
 * The failure of one Jev call. The message holds no request or response
 * text, because that can be customer content.
 * - `config`: the backend model settings cannot reach OpenRouter.
 * - `network`: the request did not get an answer (DNS, connection, TLS).
 * - `timeout`: no full answer within the time limit.
 * - `http`: the endpoint answered with an error status.
 * - `invalid-answer`: the response, or the answer to a question, does not
 *   match the schema.
 */
export class JevError extends Error {
  override readonly name = "JevError"
  constructor(
    readonly kind: "config" | "network" | "timeout" | "http" | "invalid-answer",
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const settingsSchema = z.preprocess(
  dropEmptyEnvValues,
  z.object({
    MODEL_PROVIDER: z.string().default("openai-like"),
    MODEL_PROVIDER_API_KEY: z.string().optional(),
    MODEL_PROVIDER_URL: z.string().url().default(DEFAULT_OPENROUTER_BASE),
  }),
)

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.unknown().optional(),
})

const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
})

/**
 * The OpenRouter base URL and key of the backend model settings. Jev is only
 * on OpenRouter, so a deployment with `MODEL_PROVIDER` `bedrock` or `azure`
 * gets a `config` error: its content must not go to a provider that the
 * operator did not choose.
 */
function openRouterSettings(): { base: string; apiKey: string } {
  const settings = settingsSchema.safeParse(process.env)
  if (
    !settings.success ||
    !["openrouter", "openai-like"].includes(settings.data.MODEL_PROVIDER) ||
    !settings.data.MODEL_PROVIDER_API_KEY
  )
    throw new JevError(
      "config",
      "Jev needs MODEL_PROVIDER openrouter or openai-like, an OpenRouter MODEL_PROVIDER_URL, and MODEL_PROVIDER_API_KEY.",
    )
  return {
    base: settings.data.MODEL_PROVIDER_URL,
    apiKey: settings.data.MODEL_PROVIDER_API_KEY,
  }
}

/**
 * Ask Jev the `questions` about the `state`, in one call. Returns the
 * probability of yes for each question key. The key and the base URL come
 * from the backend model settings (see `openRouterSettings`). A failure
 * throws a `JevError`. The call must not run inside an org database
 * transaction.
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
  assertNotInOrgDbContext()
  const { base, apiKey } = openRouterSettings()
  return trace.getTracer("ctxpipe-llm").startActiveSpan(
    "jev.decide",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "decide",
        "gen_ai.request.model": JEV_MODEL,
        "gen_ai.provider.name": "openrouter",
        ...options.attributes,
      },
    },
    async (span) => {
      const started = performance.now()
      try {
        const signal = AbortSignal.timeout(options.timeoutMs)
        let status: number
        let body: string
        try {
          const response = await fetch(
            new URL("../alpha/decisions", `${base.replace(/\/+$/, "")}/`),
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
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
              signal,
            },
          )
          status = response.status
          // The time limit also covers the body.
          signal.throwIfAborted()
          body = await new Promise<string>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
            response.text().then(resolve, reject)
          })
        } catch (error) {
          throw error instanceof Error && error.name === "TimeoutError"
            ? new JevError(
                "timeout",
                `Jev gave no answer in ${options.timeoutMs} ms.`,
              )
            : new JevError("network", "The Jev request got no answer.")
        }
        if (status < 200 || status > 299)
          throw new JevError("http", `Jev answered HTTP ${status}.`, status)
        let json: unknown
        try {
          json = JSON.parse(body)
        } catch {
          json = undefined
        }
        const parsed = responseSchema.safeParse(json)
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
