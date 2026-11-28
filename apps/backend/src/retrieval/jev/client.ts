// The Jev client of the backend (ADR-068). Jev (TypeSafe) answers typed
// questions with probabilities through the OpenRouter Decisions API. The
// request shape is the same as in the visual critic
// (`packages/visual-review/src/adapters/jev.ts`), but this client also
// requires a zero-data-retention (ZDR) endpoint (ADR-068 decision 7), because
// it sends customer content. It pins no provider, so OpenRouter can fall back
// among the ZDR endpoints of the model. OpenRouter lists TypeSafe as a ZDR
// endpoint of `typesafe/jev-1.14` (`GET /api/v1/endpoints/zdr`).
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { z } from "zod"

import { JEV_PROVIDER } from "../../../../../packages/aws-cdk/src/internal/knowledge-plane-settings.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import { gatewayCost } from "../../observability/gatewayCost.js"
import { gatewayRoutingError } from "../../observability/gatewayError.js"
import { openRouterSettings } from "../services/modelProvider.js"
import { openRouterProvider } from "../services/openRouterProvider.js"
import { scrubForModel } from "../services/scrubForModel.js"

/** The Jev model of the OpenRouter Decisions API. */
export const JEV_MODEL = `${JEV_PROVIDER}/jev-1.14`

/**
 * The state of a decisions request: text only. Jev gets no image bytes
 * (ADR-068 decision 6).
 */
export type JevState = string[]

/** A yes/no question. Jev answers it with a probability of yes. */
export type JevQuestion = { type: "noul"; instructions: string }

/**
 * The failure of one Jev call. The message holds no request or response
 * text, because that can be customer content. The one exception is a fixed
 * routing message of the gateway (`gatewayRoutingError`).
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

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.unknown().optional(),
})

const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
})

type DecideOptions = { timeoutMs: number; attributes: Record<string, number> }

/**
 * Ask Jev the yes/no `questions` about the `state`, in one call. Returns the
 * probability of yes for each question key. The key and the base URL come
 * from the backend model settings (see `openRouterSettings`). A failure
 * throws a `JevError`. The call must not run inside an org database
 * transaction. A call with no answer after 700 ms sends a second
 * copy of its request (a hedged request), and the first copy that ends gives
 * the result. The time limit applies to both copies.
 *
 * The call has one span (`jev.decide`) with the model, the cost
 * (`gen_ai.usage.cost`), the latency, `jev.hedged` (the second copy went
 * out), `jev.hedge_won` (the second copy ended first) and the `attributes`
 * of the caller. The span holds no prompt text: the state is customer
 * content.
 */
export async function decideNoul(
  state: JevState,
  questions: Record<string, JevQuestion>,
  options: DecideOptions,
): Promise<Map<string, number>> {
  assertNotInOrgDbContext()
  return trace.getTracer("ctxpipe-llm").startActiveSpan(
    "jev.decide",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "decide",
        "gen_ai.request.model": JEV_MODEL,
        "gen_ai.provider.name": "openrouter",
        "jev.hedged": false,
        ...options.attributes,
      },
    },
    async (span) => {
      const started = performance.now()
      try {
        // Jev is only on OpenRouter (see `openRouterSettings`).
        const settings = openRouterSettings()
        if (!settings)
          throw new JevError(
            "config",
            "Jev needs MODEL_PROVIDER openrouter or openai-like, an OpenRouter MODEL_PROVIDER_URL, and MODEL_PROVIDER_API_KEY.",
          )
        const { base, apiKey } = settings
        const request = await scrubForModel({
          model: JEV_MODEL,
          state,
          questions,
          provider: openRouterProvider(),
        })
        const timeLimit = AbortSignal.timeout(options.timeoutMs)
        const url = new URL(
          "../alpha/decisions",
          `${base.replace(/\/+$/, "")}/`,
        )
        const payload = JSON.stringify(request)
        // Each copy of the request stops at the time limit, or when the
        // first copy ends.
        const done = new AbortController()
        const signal = AbortSignal.any([timeLimit, done.signal])
        const send = async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: payload,
            signal,
          })
          // The time limit also covers the body.
          signal.throwIfAborted()
          const text = await new Promise<string>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
            response.text().then(resolve, reject)
          })
          return { status: response.status, body: text }
        }
        type Answer = { status: number; body: string }
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
          throw error instanceof Error && error.name === "TimeoutError"
            ? new JevError(
                "timeout",
                `Jev gave no answer in ${options.timeoutMs} ms.`,
              )
            : new JevError("network", "The Jev request got no answer.")
        } finally {
          clearTimeout(hedge)
          // The race has its result: stop the copy that is still in flight.
          done.abort()
          span.setAttribute("jev.hedge_won", hedgeWon ?? false)
        }
        const { status, body } = answer
        if (status < 200 || status > 299) {
          // Only a fixed routing message of the gateway: other error text
          // can echo the state.
          const routing = gatewayRoutingError(body, JEV_MODEL)
          throw new JevError(
            "http",
            routing
              ? `Jev answered HTTP ${status}: ${routing}`
              : `Jev answered HTTP ${status}.`,
            status,
          )
        }
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
        return new Map(
          Object.keys(questions).map((key) => {
            const answer = noulAnswer.safeParse(parsed.data.answers[key])
            if (!answer.success)
              throw new JevError(
                "invalid-answer",
                `Jev gave no valid yes/no answer to question ${key}.`,
              )
            return [key, answer.data.noul]
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
