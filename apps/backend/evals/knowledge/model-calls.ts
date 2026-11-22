import { createHash } from "node:crypto"

import { z } from "zod"

import { gatewayCost } from "../../src/observability/gatewayCost.js"

/*
 * The model calls of an eval run: Jev, the embedding endpoints of both
 * stacks, and the chat calls (the judge panel and the vision model). They all
 * go to the model provider
 * (`MODEL_PROVIDER_URL`). The run puts this recorder in front of `fetch`, so
 * the readers stay as they are. The recorder:
 * - keeps each Jev and embedding request and its raw answer, so that a later
 *   run can replay them with no new call (`rescore`);
 * - counts the calls and the cost of each arm and question;
 * - stops at the spend cap.
 *
 * It does not change a request. Each client sends the provider block of
 * ADR-070 itself, and `openRouterProvider.test.ts` proves it for each
 * client.
 */

type CallKind = "jev" | "embedding" | "chat" | "vision"

/** One model call, as the run folder keeps it (`calls.jsonl`). */
export const recordedCallSchema = z.object({
  arm: z.string(),
  question: z.string(),
  kind: z.enum(["jev", "embedding", "chat", "vision"]),
  /**
   * The replay key: the SHA-256 of the kind and the request body with no
   * provider block (`replayKeyOf`). A replay computes the key again from
   * `request`, so a recording with an older key also replays.
   */
  key: z.string(),
  request: z.unknown(),
  status: z.number().int(),
  /** The raw answer: the Jev probabilities or the vectors. */
  response: z.string(),
  costUsd: z.number(),
  /**
   * Audit data for a person who reads the run folder: no cost in the answer
   * (`costUsd` is the reserved value), and the time of the call.
   */
  estimated: z.boolean(),
  latencyMs: z.number(),
})
export type RecordedCall = z.infer<typeof recordedCallSchema>

/** The calls of one arm on one question. */
export const callCountsSchema = z.object({
  jev: z.number(),
  /** The questions of the Jev calls (the cost guard of ADR-069 decision 6). */
  jevQuestions: z.number(),
  embedding: z.number(),
  /** In a replay, the cost of the recorded calls when they were made. */
  costUsd: z.number(),
  /** Replay only: calls that the recording does not hold. */
  missing: z.number(),
})
export type CallCounts = z.infer<typeof callCountsSchema>

/**
 * The worst-case cost of one call of each kind, which the run reserves
 * before it sends the call. Each value is above the highest cost that the
 * bake-offs measured (ADR-063: $0.0008 for one Jev call, and $0.25 for an
 * LLM judge reply with no cost); a query embedding costs much less than
 * $0.001, and the vision eval measured at most $0.03 for one image. A call whose answer has no `usage.cost`, or that fails, keeps the
 * reserved value, so a missing cost never turns the spend cap off.
 */
const RESERVED_COST_USD: Record<CallKind, number> = {
  jev: 0.002,
  embedding: 0.001,
  chat: 0.25,
  vision: 0.05,
}

/**
 * The reservation of an embedding call grows with its input: a batch of the
 * hydrate holds up to 300,000 bytes (`maxBatchBytes`). $0.5 for each million UTF-8 bytes is above
 * the price of each embedding model of the stacks for each million tokens,
 * and each token holds at least one byte.
 */
const EMBEDDING_USD_PER_BYTE = 0.5 / 1_000_000

/** The worst-case cost of one call of `kind` with the request `body`. */
function reservationOf(kind: CallKind, body: string): number {
  if (kind !== "embedding") return RESERVED_COST_USD[kind]
  const input = z
    .object({ input: z.union([z.string(), z.array(z.string())]) })
    .safeParse(parseOr(body, {})).data?.input
  const texts = typeof input === "string" ? [input] : (input ?? [])
  const bytes = texts.reduce(
    (sum, text) => sum + Buffer.byteLength(text, "utf8"),
    0,
  )
  return Math.max(RESERVED_COST_USD.embedding, bytes * EMBEDDING_USD_PER_BYTE)
}

const answerSchema = z.object({ usage: z.unknown() }).partial()

/** The arm, the question and the counts that a call belongs to. */
type Owner = { arm: string; question: string; counts: CallCounts }

const emptyCounts = (): CallCounts => ({
  jev: 0,
  jevQuestions: 0,
  embedding: 0,
  costUsd: 0,
  missing: 0,
})

/**
 * The kind of a call to the origin of the model provider, from its path
 * and its body. A chat call of the vision client (`readImage`) names its JSON schema
 * `image_reading`.
 */
function kindOf(path: string, body: string): CallKind | null {
  if (path.endsWith("/alpha/decisions")) return "jev"
  if (path.endsWith("/embeddings")) return "embedding"
  if (path.endsWith("/chat/completions"))
    return body.includes('"name":"image_reading"') ? "vision" : "chat"
  return null
}

/**
 * The replay key of a request. The `provider` block only routes the call
 * (ZDR, data collection, the provider allowlist, the sort): it does not
 * change the answer of the model. Thus the key leaves it out, and a
 * recording from before a change of the routing still replays (CTX-1450
 * added `only`). `body` is the parsed JSON body, or the text of a body that
 * is not JSON.
 */
function replayKeyOf(kind: CallKind, body: unknown): string {
  const answerFields =
    body && typeof body === "object" && !Array.isArray(body)
      ? JSON.stringify({ ...body, provider: undefined })
      : String(body)
  return createHash("sha256").update(`${kind}\n${answerFields}`).digest("hex")
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

/** The number of questions of a Jev request body. */
const questionsOf = (body: string): number =>
  Object.keys(
    z
      .object({ questions: z.record(z.string(), z.unknown()) })
      .safeParse(parseOr(body, {})).data?.questions ?? {},
  ).length

export class ModelCalls {
  readonly records: RecordedCall[] = []
  /** The cost of the calls that went out. A replay sends none. */
  spentUsd = 0
  /** True after the spend cap stopped a call. Each later call stops too. */
  stopped = false
  /** The reserved cost of the calls that are in flight. */
  private reservedUsd = 0
  private readonly inFlight = new Set<Promise<Response>>()
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
    private readonly options: {
      /** False: count and cap the calls, but keep no record of them. */
      keepRecords?: boolean
    } = {},
  ) {
    this.origin = new URL(baseUrl).origin
    this.replay = replay ? new Map() : null
    for (const call of replay ?? []) {
      const key = this.replayKey(
        call.arm,
        call.question,
        replayKeyOf(call.kind, call.request),
      )
      this.replay?.set(key, [...(this.replay.get(key) ?? []), call])
    }
  }

  /** The spend of the calls, for the run folder. */
  summary() {
    return {
      capUsd: this.capUsd,
      spentUsd: this.spentUsd,
      stopped: this.stopped,
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

  /**
   * Wait for the calls that are still in flight. A reader can stop to wait
   * for a call at the end of its time budget while the call goes on, so the
   * run waits for them before it closes the counts of a question.
   */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /** Put the recorder in front of `fetch`. Call the result to remove it. */
  install(): () => void {
    const next = globalThis.fetch
    const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
      // The arm and the question of a call are the ones at its dispatch.
      const owner: Owner = { ...this.context, counts: this.counts }
      const call = this.handle(new Request(input, init), next, owner)
      this.inFlight.add(call)
      void call.finally(() => this.inFlight.delete(call)).catch(() => {})
      return call
    }
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
    owner: Owner,
  ): Promise<Response> {
    const url = new URL(request.url)
    if (url.origin !== this.origin) return next(request)
    const body = await request.clone().text()
    const kind = kindOf(url.pathname, body)
    if (!kind) return next(request)
    const parsed = parseOr(body, body)
    const key = replayKeyOf(kind, parsed)
    if (this.replay) return this.replayed(kind, key, body, owner)
    // The hard spend cap: each call in flight holds its worst-case cost, and
    // a call that would take the spent and reserved total over the cap is
    // not sent. The check and the reservation have no `await` between them,
    // so calls in parallel cannot pass the cap together.
    const reserved = reservationOf(kind, body)
    if (
      this.stopped ||
      this.spentUsd + this.reservedUsd + reserved > this.capUsd
    ) {
      this.stopped = true
      return unavailable("The spend cap of the eval run is spent.")
    }
    this.reservedUsd += reserved
    const started = performance.now()
    let response: Response
    let text: string
    try {
      response = await next(request)
      text = await response.text()
    } catch (error) {
      // The provider can charge a call that failed on the way back.
      this.spentUsd += reserved
      owner.counts.costUsd += reserved
      throw error
    } finally {
      this.reservedUsd -= reserved
    }
    const latencyMs = performance.now() - started
    const known = gatewayCost(
      answerSchema.safeParse(parseOr(text, {})).data?.usage,
    )
    const costUsd = known ?? reserved
    this.spentUsd += costUsd
    owner.counts.costUsd += costUsd
    // A chat reply is no retrieval answer, so the counts of a question leave
    // it out. The record keeps it as evidence (the probe reads it).
    if (kind === "jev" || kind === "embedding") owner.counts[kind] += 1
    if (kind === "jev") owner.counts.jevQuestions += questionsOf(body)
    if (this.options.keepRecords !== false)
      this.records.push({
        arm: owner.arm,
        question: owner.question,
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

  /**
   * The recorded answer of a call: the answers of the same request of the
   * same arm and question come in the recorded order, so a retry gets the
   * answer that it got live. After the last one, the same request gets the
   * last answer again.
   */
  private replayed(
    kind: CallKind,
    key: string,
    body: string,
    owner: Owner,
  ): Response {
    const queue = this.replay?.get(
      this.replayKey(owner.arm, owner.question, key),
    )
    const recorded = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    // A replay is only of `run` and `rescore`, which make no chat call.
    if (kind === "chat" || kind === "vision" || !recorded) {
      owner.counts.missing += 1
      return unavailable("The recording holds no answer for this call.")
    }
    owner.counts[kind] += 1
    if (kind === "jev") owner.counts.jevQuestions += questionsOf(body)
    owner.counts.costUsd += recorded.costUsd
    this.records.push(recorded)
    return new Response(recorded.response, {
      status: recorded.status,
      headers: { "content-type": "application/json" },
    })
  }
}
