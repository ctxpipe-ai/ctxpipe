// The decision calls of the backend (ADR-068). A decision model (Jev by
// default) answers typed questions with probabilities. The calls go through
// the `decide()` activity of TanStack AI with the adapter of the configured
// provider (`decisionModelSettings`). A call to OpenRouter requires a
// zero-data-retention (ZDR) endpoint (ADR-068 decision 7), because it sends
// customer content. It pins no provider, so OpenRouter can fall back among
// the ZDR endpoints of the model.
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { decide, isEvaluateError } from "@tanstack/ai"
import { z } from "zod"

import { assertNotInOrgDbContext } from "../../db/client.js"
import { gatewayRoutingError } from "../../observability/gatewayError.js"
import { scrubForModel } from "../services/scrubForModel.js"
import { decisionAdapter, decisionModelSettings } from "./decision-model.js"

export { JEV_MODEL } from "./decision-model.js"

/**
 * The state of a decisions request: text only. The decision model gets no
 * image bytes (ADR-068 decision 6).
 */
export type JevState = string[]

/**
 * A yes/no question (the wire form of `boolean()`). The decision model
 * answers it with a probability of yes.
 */
export type JevQuestion = { type: "noul"; instructions: string }

/**
 * The failure of one decision call. The message holds no request or
 * response text, because that can be customer content. The one exception is
 * a fixed routing message of OpenRouter (`gatewayRoutingError`).
 * - `config`: the backend settings give no decision model.
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

type DecideOptions = { timeoutMs: number; attributes: Record<string, number> }

/**
 * Ask the decision model the yes/no `questions` about the `state`, in one
 * call. Returns the probability of yes for each question key. The model and
 * its endpoint come from the backend settings (`decisionModelSettings`). A
 * failure throws a `JevError`. The call must not run inside an org database
 * transaction. A call with no answer after 700 ms sends a second copy of its
 * request (a hedged request), and the first copy that ends gives the result.
 * The time limit applies to both copies.
 *
 * The call has one span (`jev.decide`) with the provider, the model, the
 * cost (`gen_ai.usage.cost`, when the provider reports it), the latency,
 * `jev.hedged` (the second copy went out), `jev.hedge_won` (the second copy
 * ended first) and the `attributes` of the caller. The span holds no prompt
 * text: the state is customer content.
 */
export async function decideNoul(
  state: JevState,
  questions: Record<string, JevQuestion>,
  options: DecideOptions,
): Promise<Map<string, number>> {
  assertNotInOrgDbContext()
  const settings = decisionModelSettings()
  return trace.getTracer("ctxpipe-llm").startActiveSpan(
    "jev.decide",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "decide",
        ...(settings && {
          "gen_ai.request.model": settings.model,
          "gen_ai.provider.name": settings.provider,
        }),
        "jev.hedged": false,
        ...options.attributes,
      },
    },
    async (span) => {
      const started = performance.now()
      try {
        if (!settings)
          throw new JevError(
            "config",
            "The decision model needs DECISION_MODEL_API_KEY, or MODEL_PROVIDER openrouter or openai-like with MODEL_PROVIDER_API_KEY.",
          )
        const { adapter, modelOptions } = decisionAdapter(settings)
        const scrubbed = await scrubForModel({ state, questions })
        // Each copy of the request stops at the time limit, or when the
        // first copy ends.
        const timeLimit = AbortSignal.timeout(options.timeoutMs)
        const done = new AbortController()
        const abortSignal = AbortSignal.any([timeLimit, done.signal])
        const send = () =>
          decide({
            adapter,
            ...scrubbed,
            modelOptions,
            abortSignal,
            // No log of the SDK: an error can hold response text, and that
            // can echo the state.
            debug: false,
          })
        type Answer = Awaited<ReturnType<typeof send>>
        let answer: Answer
        let hedge: ReturnType<typeof setTimeout> | undefined
        // True when the second copy ended first, also with a failure.
        let hedgeWon: boolean | undefined
        const ended = (copy: boolean) => () => {
          hedgeWon ??= copy
        }
        try {
          // The first copy that ends gives the result, also a failure: the
          // second copy is no retry.
          answer = await Promise.race([
            send().finally(ended(false)),
            new Promise<Answer>((resolve, reject) => {
              // Most Jev calls end in about 450 ms, but about 2% take 1.1 to
              // 2.1 s, also small ones: the provider is slow, not the
              // request. Almost all other calls end before 700 ms, so the
              // copy adds about 2% more calls, and a slow call ends in about
              // 1.2 s (CTX-1590).
              hedge = setTimeout(() => {
                span.setAttribute("jev.hedged", true)
                send().finally(ended(true)).then(resolve, reject)
              }, 700)
            }),
          ])
        } catch (error) {
          throw jevErrorOf(error, settings, options.timeoutMs)
        } finally {
          clearTimeout(hedge)
          // The race has its result: stop the copy that is still in flight.
          done.abort()
          span.setAttribute("jev.hedge_won", hedgeWon ?? false)
        }
        const cost = answer.meta.usage.cost
        if (cost !== undefined) span.setAttribute("gen_ai.usage.cost", cost)
        return new Map(
          Object.keys(questions).map((key) => {
            const probability = noulProbability.safeParse(
              (answer as Record<string, unknown>)[key],
            )
            if (!probability.success)
              throw new JevError(
                "invalid-answer",
                `The decision model gave no valid yes/no answer to question ${key}.`,
              )
            return [key, probability.data.probability]
          }),
        )
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

const noulProbability = z.object({
  type: z.literal("boolean"),
  probability: z.number().min(0).max(1),
})

/**
 * The `JevError` of a failed `decide()` call. Only a fixed routing message
 * of OpenRouter keeps text of the answer: other error text can echo the
 * state.
 */
function jevErrorOf(
  error: unknown,
  settings: { provider: string; model: string },
  timeoutMs: number,
): JevError {
  if (!(error instanceof Error))
    return new JevError("network", "The decision request got no answer.")
  if (error.name === "TimeoutError")
    return new JevError(
      "timeout",
      `The decision model gave no answer in ${timeoutMs} ms.`,
    )
  const { status, body } = error as { status?: unknown; body?: unknown }
  if (typeof status === "number") {
    const routing =
      settings.provider === "openrouter" && typeof body === "string"
        ? gatewayRoutingError(body, settings.model)
        : undefined
    return new JevError(
      "http",
      routing
        ? `The decision model answered HTTP ${status}: ${routing}`
        : `The decision model answered HTTP ${status}.`,
      status,
    )
  }
  // A failed fetch is a `TypeError`; the OpenAI SDK names its own.
  if (error instanceof TypeError || error.name === "APIConnectionError")
    return new JevError("network", "The decision request got no answer.")
  // A refusal, an answer of another type, or a body that is no answer.
  return new JevError(
    "invalid-answer",
    isEvaluateError(error)
      ? `The decision model did not answer (${error.code}).`
      : "The decision response does not match the schema.",
  )
}
