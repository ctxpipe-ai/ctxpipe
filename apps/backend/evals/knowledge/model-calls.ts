import { createHash } from "node:crypto"

import { gatewayCost } from "../../src/observability/gatewayCost.js"

/*
 * The model calls of an eval run: Jev, the embedding endpoints of both
 * stacks, and the judge panel. They all go to the model provider
 * (`MODEL_PROVIDER_URL`). The run puts this recorder in front of `fetch`, so
 * the readers stay as they are. The recorder:
 * - keeps each request and its raw answer, so that a later run can replay
 *   them with no new call (`rescore`);
 * - counts the calls and the cost of each arm and question;
 * - stops at the spend cap.
 */

export type CallKind = "jev" | "embedding" | "panel"

/** One model call, as the run folder keeps it (`calls.jsonl`). */
export type RecordedCall = {
  arm: string
  question: string
  kind: CallKind
  /** The SHA-256 of the kind and the request body: the replay key. */
  key: string
  request: unknown
  status: number
  /** The raw answer: the Jev probabilities, the vectors, the panel reply. */
  response: string
  costUsd: number
  /** True when the answer had no cost, so `costUsd` is the upper estimate. */
  estimated: boolean
  latencyMs: number
}

/** The calls of one arm on one question. */
export type CallCounts = {
  jev: number
  embedding: number
  panel: number
  costUsd: number
  /** Replay only: calls that the recording does not hold. */
  missing: number
}

/**
 * The cost of a call whose answer has no `usage.cost`: above the highest
 * cost that we saw for each kind (ADR-063 decision 5 for Jev and a panel
 * model). A missing cost never turns the spend cap off.
 */
const UNKNOWN_COST_USD: Record<CallKind, number> = {
  jev: 0.002,
  embedding: 0.001,
  panel: 0.25,
}

const emptyCounts = (): CallCounts => ({
  jev: 0,
  embedding: 0,
  panel: 0,
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

export class ModelCalls {
  readonly records: RecordedCall[] = []
  spentUsd = 0
  /** True after the spend cap stopped a call. The run then stops. */
  stopped = false
  private context = { arm: "", question: "" }
  private counts = emptyCounts()
  private readonly origin: string
  private readonly replay: Map<string, RecordedCall> | null

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
    this.replay = replay
      ? new Map(replay.map((call) => [call.key, call]))
      : null
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

  private async handle(
    request: Request,
    next: typeof fetch,
  ): Promise<Response> {
    const url = new URL(request.url)
    const kind = url.origin === this.origin ? kindOf(url.pathname) : null
    if (!kind) return next(request)
    const body = await request.clone().text()
    const key = createHash("sha256").update(`${kind}\n${body}`).digest("hex")
    if (this.replay) {
      const recorded = this.replay.get(key)
      if (!recorded) {
        this.counts.missing += 1
        return unavailable("The recording holds no answer for this call.")
      }
      this.count(kind, 0)
      this.records.push({
        ...recorded,
        arm: this.context.arm,
        question: this.context.question,
      })
      return new Response(recorded.response, {
        status: recorded.status,
        headers: { "content-type": "application/json" },
      })
    }
    if (this.spentUsd >= this.capUsd) {
      this.stopped = true
      return unavailable("The spend cap of the eval run is spent.")
    }
    const started = performance.now()
    const response = await next(request)
    const text = await response.text()
    const latencyMs = performance.now() - started
    let usage: unknown
    try {
      usage = (JSON.parse(text) as { usage?: unknown }).usage
    } catch {
      usage = undefined
    }
    const known = gatewayCost(usage)
    const costUsd = known ?? UNKNOWN_COST_USD[kind]
    this.spentUsd += costUsd
    this.count(kind, costUsd)
    let parsed: unknown = body
    try {
      parsed = JSON.parse(body)
    } catch {
      // Keep the body as text.
    }
    this.records.push({
      arm: this.context.arm,
      question: this.context.question,
      kind,
      key,
      request: parsed,
      status: response.status,
      response: text,
      costUsd,
      estimated: known === undefined,
      latencyMs: Math.round(latencyMs),
    })
    // The text is decoded, so only the content type still applies.
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    })
  }

  private count(kind: CallKind, costUsd: number): void {
    this.counts[kind] += 1
    this.counts.costUsd += costUsd
  }
}
