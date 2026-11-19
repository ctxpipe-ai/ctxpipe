import { createHash } from "node:crypto"

import { z } from "zod"

import { gatewayCost } from "../../src/observability/gatewayCost.js"

/*
 * The model calls of an eval run: Jev, the embedding endpoints of both
 * stacks, and the judge panel. They all go to the model provider
 * (`MODEL_PROVIDER_URL`). The run puts this recorder in front of `fetch`, so
 * the readers stay as they are. The recorder:
 * - keeps each Jev and embedding request and its raw answer, so that a later
 *   run can replay them with no new call (`rescore`);
 * - counts the calls and the cost of each arm and question;
 * - stops at the spend cap.
 */

type CallKind = "jev" | "embedding" | "panel"

/** One model call, as the run folder keeps it (`calls.jsonl`). */
export const recordedCallSchema = z.object({
  arm: z.string(),
  question: z.string(),
  kind: z.enum(["jev", "embedding"]),
  /** The SHA-256 of the kind and the request body: the replay key. */
  key: z.string(),
  request: z.unknown(),
  status: z.number().int(),
  /** The raw answer: the Jev probabilities or the vectors. */
  response: z.string(),
  costUsd: z.number(),
  /** True when the answer had no cost, so `costUsd` is the upper estimate. */
  estimated: z.boolean(),
  latencyMs: z.number(),
})
export type RecordedCall = z.infer<typeof recordedCallSchema>

/** The calls of one arm on one question. */
export const callCountsSchema = z.object({
  jev: z.number(),
  embedding: z.number(),
  /** In a replay, the cost of the recorded calls when they were made. */
  costUsd: z.number(),
  /** Replay only: calls that the recording does not hold. */
  missing: z.number(),
})
export type CallCounts = z.infer<typeof callCountsSchema>

/**
 * The first upper cost of a call of each kind: above the highest cost that
 * we saw (ADR-063 decision 5 for Jev and a panel model). A call whose answer
 * has no `usage.cost` counts at the upper cost, so a missing cost never
 * turns the spend cap off.
 */
const FIRST_UPPER_COST_USD: Record<CallKind, number> = {
  jev: 0.002,
  embedding: 0.001,
  panel: 0.25,
}

const answerSchema = z.object({ usage: z.unknown() }).partial()

const emptyCounts = (): CallCounts => ({
  jev: 0,
  embedding: 0,
  costUsd: 0,
  missing: 0,
})

/** The kind of a call to the origin of the model provider, from its path. */
function kindOf(path: string): CallKind | null {
  if (path.endsWith("/alpha/decisions")) return "jev"
  if (path.endsWith("/embeddings")) return "embedding"
  if (path.endsWith("/chat/completions")) return "panel"
  return null
}

const unavailable = (reason: string) =>
  Response.json({ error: { message: reason } }, { status: 503 })

const parseOr = (text: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export class ModelCalls {
  readonly records: RecordedCall[] = []
  /** The cost of the calls that went out. A replay sends none. */
  spentUsd = 0
  /** True after the spend cap stopped a call. The run then stops. */
  stopped = false
  /** The upper cost of the calls that are in flight. */
  private reservedUsd = 0
  /**
   * The upper cost of a call of each kind: the first value, or the highest
   * cost of a call of the kind in this run.
   */
  private readonly upperUsd = { ...FIRST_UPPER_COST_USD }
  private context = { arm: "", question: "" }
  private counts = emptyCounts()
  private readonly origin: string
  /** The recorded answers of each arm, question and request, in order. */
  private readonly replay: Map<string, RecordedCall[]> | null

  /**
   * `baseUrl` is `MODEL_PROVIDER_URL`. `capUsd` is the spend cap of the run.
   * With `replay`, the recorder answers each call from it and sends nothing.
   */
  constructor(
    baseUrl: string,
    private readonly capUsd: number,
    replay?: readonly RecordedCall[],
  ) {
    this.origin = new URL(baseUrl).origin
    this.replay = replay ? new Map() : null
    for (const call of replay ?? []) {
      const key = this.replayKey(call.arm, call.question, call.key)
      this.replay?.set(key, [...(this.replay.get(key) ?? []), call])
    }
  }

  /** Start counting the calls of `arm` on `question`. */
  begin(arm: string, question: string): void {
    this.context = { arm, question }
    this.counts = emptyCounts()
  }

  /** The calls since the last `begin`. */
  end(): CallCounts {
    return { ...this.counts }
  }

  /** Put the recorder in front of `fetch`. Call the result to remove it. */
  install(): () => void {
    const next = globalThis.fetch
    const wrapped = (input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(new Request(input, init), next)
    globalThis.fetch = Object.assign(wrapped, next)
    return () => {
      globalThis.fetch = next
    }
  }

  private replayKey(arm: string, question: string, key: string): string {
    return `${arm}\0${question}\0${key}`
  }

  private async handle(
    request: Request,
    next: typeof fetch,
  ): Promise<Response> {
    const url = new URL(request.url)
    const kind = url.origin === this.origin ? kindOf(url.pathname) : null
    if (!kind) return next(request)
    const body = await request.clone().text()
    const key = createHash("sha256").update(`${kind}\n${body}`).digest("hex")
    if (this.replay) return this.replayed(kind, key)
    // Each call in flight holds its upper cost, so that calls in parallel
    // cannot pass the cap together. Only a call that costs more than each
    // earlier call of its kind can pass the cap, by that difference.
    const upper = this.upperUsd[kind]
    if (this.spentUsd + this.reservedUsd + upper > this.capUsd) {
      this.stopped = true
      return unavailable("The spend cap of the eval run is spent.")
    }
    this.reservedUsd += upper
    const started = performance.now()
    let response: Response
    let text: string
    try {
      response = await next(request)
      text = await response.text()
    } finally {
      this.reservedUsd -= upper
    }
    const latencyMs = performance.now() - started
    const known = gatewayCost(
      answerSchema.safeParse(parseOr(text, {})).data?.usage,
    )
    const costUsd = known ?? upper
    this.upperUsd[kind] = Math.max(upper, costUsd)
    this.spentUsd += costUsd
    this.counts.costUsd += costUsd
    // A panel reply is no retrieval answer: the votes file keeps it.
    if (kind !== "panel") {
      this.counts[kind] += 1
      this.records.push({
        arm: this.context.arm,
        question: this.context.question,
        kind,
        key,
        request: parseOr(body, body),
        status: response.status,
        response: text,
        costUsd,
        estimated: known === undefined,
        latencyMs: Math.round(latencyMs),
      })
    }
    // The text is decoded, so only the content type still applies.
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    })
  }

  /**
   * The recorded answer of a call: the answers of the same request of the
   * same arm and question come in the recorded order, so a retry gets the
   * answer that it got live. After the last one, the same request gets the
   * last answer again.
   */
  private replayed(kind: CallKind, key: string): Response {
    const queue = this.replay?.get(
      this.replayKey(this.context.arm, this.context.question, key),
    )
    const recorded = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    if (kind === "panel" || !recorded) {
      this.counts.missing += 1
      return unavailable("The recording holds no answer for this call.")
    }
    this.counts[kind] += 1
    this.counts.costUsd += recorded.costUsd
    this.records.push(recorded)
    return new Response(recorded.response, {
      status: recorded.status,
      headers: { "content-type": "application/json" },
    })
  }
}
