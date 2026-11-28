import { createHash } from "node:crypto"

import { z } from "zod"

import { gatewayCost } from "../../src/observability/gatewayCost.js"
import {
  DISAGREEMENT_FACTS,
  SYMMETRIC_FACTS,
} from "../../src/retrieval/jev/disagreement.js"

/*
 * The model calls of an eval run: the decision model (Jev by default), the
 * embedding endpoints of both stacks, and the chat calls (the judge panel and
 * the vision model). They go to the model provider (`MODEL_PROVIDER_URL`);
 * a decision call can also go to another provider (`DECISION_MODEL_URL`).
 * The run puts this recorder in front of `fetch`, so
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
  /** The request body. A replay finds the call by it (`replayKeyOf`). */
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
  /**
   * The calls with an HTTP error status, or with no answer. A call that the
   * reader stopped at the end of its time budget is not a failed call. A
   * run folder from before this count has none (0).
   */
  failed: z.number().default(0),
  /**
   * Replay only: the Jev questions that no recorded call asked about the
   * same items, which got the p(yes) of `unrecordedYes` (see
   * `ModelCalls.composed`). A run folder from before this count has none
   * (0).
   */
  unrecorded: z.number().default(0),
  /**
   * The copies of a request that went out while a copy of the same request
   * was in flight: the hedge of the Jev client, which sends a second copy
   * of a slow call. Each one shows a provider stall. A run folder from
   * before this count has none (0).
   */
  hedged: z.number().default(0),
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
  // A decision call costs at most its input tokens at the decision price,
  // and each token holds at least one byte of the body.
  if (kind === "jev")
    return Math.max(
      RESERVED_COST_USD.jev,
      Buffer.byteLength(body, "utf8") * DECISION_USD_PER_INPUT_TOKEN,
    )
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
  failed: 0,
  unrecorded: 0,
  hedged: 0,
})

/**
 * True for the path of a decision call: OpenRouter `/api/alpha/decisions`,
 * OpenAI `/v1/decisions`. A decision call can go to its own provider
 * (`DECISION_MODEL_URL`), so the recorder takes it from any origin.
 */
const isDecisionPath = (path: string) => path.endsWith("/decisions")

/**
 * The kind of a call to the origin of the model provider, from its path
 * and its body. A chat call of the vision client (`readImage`) names its JSON schema
 * `image_reading`.
 */
function kindOf(path: string, body: string): CallKind | null {
  if (isDecisionPath(path)) return "jev"
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

/**
 * The number of questions of a decision request body: a record of questions
 * (OpenRouter) or a list (OpenAI).
 */
const questionsOf = (body: string): number =>
  Object.keys(
    z
      .object({
        questions: z.union([
          z.array(z.unknown()),
          z.record(z.string(), z.unknown()),
        ]),
      })
      .safeParse(parseOr(body, {})).data?.questions ?? {},
  ).length

/**
 * The price of the OpenAI and the Gemini decision models for each input
 * token ($0.10 for each million, no charge for output; read 2026-11-26 and
 * 2026-11-28). Their answers report tokens but no cost. Jev costs less
 * ($0.042), so the reservation of a decision call also holds for Jev.
 */
const DECISION_USD_PER_INPUT_TOKEN = 0.1 / 1_000_000

/**
 * The cost of a decision answer from its input tokens, when it has them.
 * OpenAI reports `input_tokens`, Gemini `total_input_tokens`.
 */
function decisionTokenCost(usage: unknown): number | undefined {
  const tokens = z
    .union([
      z.object({ input_tokens: z.number() }).transform((u) => u.input_tokens),
      z
        .object({ total_input_tokens: z.number() })
        .transform((u) => u.total_input_tokens),
    ])
    .safeParse(usage).data
  return tokens === undefined
    ? undefined
    : tokens * DECISION_USD_PER_INPUT_TOKEN
}

/**
 * The content keys of each question of a Jev request: the lines of the
 * state that are not an item (for example the question and the intent), and
 * the question with each "Candidate n" or "Item n" in it replaced by the
 * label and the data of that item. Thus the same question about the same
 * items has the same key in another batch and under other numbers. A
 * symmetric pair fact of the disagreement step (`SYMMETRIC_FACTS`) has a
 * second key, with the two items in the other order. Null for a body that
 * is not a Jev request: an OpenAI decision request (`input` and a list of
 * questions) has no content keys, so a replay composes no answer for it.
 */
function contentKeysOf(body: unknown): Map<string, string[]> | null {
  const request = z
    .object({
      state: z.array(z.string()),
      questions: z.record(z.string(), z.unknown()),
    })
    .safeParse(body).data
  if (!request) return null
  const items = new Map<string, string>()
  const others: string[] = []
  for (let index = 0; index < request.state.length; index++) {
    const line = request.state[index] ?? ""
    // An item of a Jev state: its label line, then its `<data>` block.
    const item = /^(Candidate|Item) (\d+)\b(.*)$/.exec(line)
    if (!item) {
      others.push(line)
      continue
    }
    items.set(
      `${item[1]} ${item[2]}`,
      `${item[1]}${item[3]}\n${request.state[index + 1] ?? ""}`,
    )
    index += 1
  }
  const keyOf = (question: unknown, swap?: [string, string]) =>
    createHash("sha256")
      .update(
        [
          ...others,
          JSON.stringify(question).replace(
            /\b(Candidate|Item) \d+\b/g,
            (name) => {
              const named =
                name === swap?.[0]
                  ? swap[1]
                  : name === swap?.[1]
                    ? swap[0]
                    : name
              return `[${items.get(named) ?? named}]`
            },
          ),
        ].join("\n"),
      )
      .digest("hex")
  return new Map(
    Object.entries(request.questions).map(([key, question]) => {
      const names = [
        ...new Set(
          JSON.stringify(question).match(/\b(Candidate|Item) \d+\b/g) ?? [],
        ),
      ]
      const symmetric =
        names.length === 2 &&
        (SYMMETRIC_FACTS as readonly string[]).includes(key.split(".")[0] ?? "")
      return [
        key,
        symmetric
          ? [keyOf(question), keyOf(question, names as [string, string])]
          : [keyOf(question)],
      ]
    }),
  )
}

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
   * The calls that the recording answered, and (with `liveFallback`) the
   * calls that went out because the recording had no answer.
   */
  private readonly reuse = { reused: 0, live: 0 }
  /**
   * The recorded Jev answer of each arm, question and content key of a Jev
   * question (`contentKeysOf`), with its call: the first one that the
   * recording holds.
   */
  private readonly recordedAnswers = new Map<
    string,
    { answer: unknown; call: RecordedCall }
  >()
  /** The recorded Jev calls with an answer. */
  private readonly jevCalls: RecordedCall[] = []
  /** The recorded calls that a composed answer used, kept in `records`. */
  private readonly composedFrom = new Set<RecordedCall>()
  /**
   * The copies of each request (`replayKeyOf`) of an arm and question that
   * are in flight, and the cost of a copy that answered while they were in
   * flight. The Jev client
   * sends a second copy of a slow request, and stops the copy that did not
   * answer first after the answer. The stopped copy then costs about the
   * same as its sibling, not the reservation.
   */
  private readonly copies = new Map<
    string,
    { inFlight: number; answeredUsd?: number }
  >()

  /**
   * `baseUrl` is `MODEL_PROVIDER_URL`. `capUsd` is the spend cap of the run.
   * With `replay`, the recorder answers each call from it and sends nothing.
   * With `replay` and `liveFallback`, a call that the recording does not hold
   * goes out (under the spend cap), and the recorder keeps it. A recorded
   * call that failed (HTTP 400 or more) is then no answer: the request goes
   * out again, so a failure of the earlier run does not come back on each
   * later run.
   * With `unrecordedYes`, a replay with no live fallback gives a Jev question that no recorded
   * call asked this p(yes), and the call does not miss (`composed`).
   */
  constructor(
    baseUrl: string,
    private readonly capUsd: number,
    replay?: readonly RecordedCall[],
    private readonly options: {
      /** False: count and cap the calls, but keep no record of them. */
      keepRecords?: boolean
      /** Send a call that `replay` does not hold, instead of a 503. */
      liveFallback?: boolean
      unrecordedYes?: number
    } = {},
  ) {
    this.origin = new URL(baseUrl).origin
    this.replay = replay ? new Map() : null
    for (const call of replay ?? []) {
      if (options.liveFallback && call.status >= 400) continue
      const key = this.replayKey(
        call.arm,
        call.question,
        replayKeyOf(call.kind, call.request),
      )
      this.replay?.set(key, [...(this.replay.get(key) ?? []), call])
      if (call.kind !== "jev" || call.status >= 400) continue
      this.jevCalls.push(call)
      const answers = z
        .object({ answers: z.record(z.string(), z.unknown()) })
        .safeParse(parseOr(call.response, {})).data?.answers
      for (const [question, contents] of contentKeysOf(call.request) ?? [])
        for (const content of contents) {
          const answerKey = this.replayKey(call.arm, call.question, content)
          if (
            answers?.[question] !== undefined &&
            !this.recordedAnswers.has(answerKey)
          )
            this.recordedAnswers.set(answerKey, {
              answer: answers[question],
              call,
            })
        }
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

  /** The calls that the recording answered, and those that went out. */
  reuseSummary(): { reused: number; live: number } {
    return { ...this.reuse }
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
    if (url.origin !== this.origin && !isDecisionPath(url.pathname))
      return next(request)
    const body = await request.clone().text()
    const kind = kindOf(url.pathname, body)
    if (!kind) return next(request)
    const parsed = parseOr(body, body)
    const key = replayKeyOf(kind, parsed)
    if (this.replay) {
      const replayed = this.replayed(kind, key, body, owner)
      if (replayed) {
        this.reuse.reused += 1
        return replayed
      }
      if (!this.options.liveFallback) {
        owner.counts.missing += 1
        return unavailable("The recording holds no answer for this call.")
      }
    }
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
    // Only a call that goes out counts as live.
    if (this.replay) this.reuse.live += 1
    this.reservedUsd += reserved
    const copiesKey = this.replayKey(owner.arm, owner.question, key)
    const copies = this.copies.get(copiesKey) ?? { inFlight: 0 }
    if (copies.inFlight > 0) owner.counts.hedged += 1
    copies.inFlight += 1
    this.copies.set(copiesKey, copies)
    const started = performance.now()
    let response: Response
    let text: string
    try {
      response = await next(request)
      text = await response.text()
    } catch (error) {
      // The provider can charge a call that failed on the way back. A copy
      // that the Jev client stopped because its sibling answered costs what
      // the sibling cost.
      const siblingUsd = request.signal.aborted ? copies.answeredUsd : undefined
      const costUsd = siblingUsd ?? reserved
      this.spentUsd += costUsd
      owner.counts.costUsd += costUsd
      if (!request.signal.aborted) owner.counts.failed += 1
      throw error
    } finally {
      this.reservedUsd -= reserved
      copies.inFlight -= 1
      if (copies.inFlight === 0) this.copies.delete(copiesKey)
    }
    const latencyMs = performance.now() - started
    const usage = answerSchema.safeParse(parseOr(text, {})).data?.usage
    const known =
      gatewayCost(usage) ??
      (kind === "jev" ? decisionTokenCost(usage) : undefined)
    const costUsd = known ?? reserved
    copies.answeredUsd = costUsd
    this.spentUsd += costUsd
    owner.counts.costUsd += costUsd
    // A chat reply is no retrieval answer, so the counts of a question leave
    // it out. The record keeps it as evidence (the probe reads it).
    if (kind === "jev" || kind === "embedding") owner.counts[kind] += 1
    if (!response.ok) owner.counts.failed += 1
    if (kind === "jev") owner.counts.jevQuestions += questionsOf(body)
    if (this.options.keepRecords !== false)
      this.records.push({
        arm: owner.arm,
        question: owner.question,
        kind,
        request: parsed,
        status: response.status,
        response: text,
        costUsd,
        estimated: known === undefined,
        latencyMs: Math.round(latencyMs),
      })
    // The text is decoded, so only the content type still applies, and the
    // wait of a rate limit (`askJson` reads it).
    const retryAfter = response.headers.get("retry-after")
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    })
  }

  /**
   * The recorded answer of a call: the answers of the same request of the
   * same arm and question come in the recorded order, so a retry gets the
   * answer that it got live. After the last one, the same request gets the
   * last answer again. Null when the recording holds no answer.
   */
  private replayed(
    kind: CallKind,
    key: string,
    body: string,
    owner: Owner,
  ): Response | null {
    const queue = this.replay?.get(
      this.replayKey(owner.arm, owner.question, key),
    )
    const recorded = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    // With a live fallback, a changed request goes out, so that the run
    // measures it.
    if (!recorded && kind === "jev" && !this.options.liveFallback) {
      const composed = this.composed(parseOr(body, body), owner)
      if (composed) return composed
    }
    // A replay is only of `run` and `rescore`, which make no chat call.
    if (kind === "chat" || kind === "vision" || !recorded) return null
    owner.counts[kind] += 1
    if (kind === "jev") owner.counts.jevQuestions += questionsOf(body)
    if (recorded.status >= 400) owner.counts.failed += 1
    owner.counts.costUsd += recorded.costUsd
    this.records.push(recorded)
    return new Response(recorded.response, {
      status: recorded.status,
      headers: { "content-type": "application/json" },
    })
  }

  /**
   * The answer of a Jev request that the recording does not hold, from the
   * recorded answers of its questions in other calls of the same arm and
   * question (`contentKeysOf`). Thus a change of the batches of Jev, or a
   * step that asks its questions in another round, replays. The batch can
   * change the answers of a live call, so a live run still judges such a
   * change.
   *
   * A question that no recorded call asked makes the call miss (null), as
   * a new request does. With `unrecordedYes`, a disagreement fact
   * (`DISAGREEMENT_FACTS`) gets that p(yes) instead and counts as
   * `unrecorded`: then a change that asks facts before it knows which items
   * it needs replays. Two rescores, with 0 and with 1, show that the change
   * does not read these answers when they give the same scores. Another
   * question (for example the judgment of a new candidate of a deeper walk)
   * still makes the call miss.
   *
   * The cost of a composed answer is an estimate: the length of its request
   * at the cost for each character of the recorded Jev calls that it used,
   * or of all recorded Jev calls when it used none. The cost of a Jev call
   * grows with its text. The recorded calls that it used go to `records`,
   * so that a replay of this run composes the same answer.
   */
  private composed(body: unknown, owner: Owner): Response | null {
    const keys = contentKeysOf(body)
    if (!keys) return null
    const fill = this.options.unrecordedYes
    const answers: Record<string, unknown> = {}
    const used: RecordedCall[] = []
    let unrecorded = 0
    for (const [question, contents] of keys) {
      const found = contents
        .map((content) =>
          this.recordedAnswers.get(
            this.replayKey(owner.arm, owner.question, content),
          ),
        )
        .find((entry) => entry !== undefined)
      const fact = (DISAGREEMENT_FACTS as readonly string[]).includes(
        question.split(".")[0] ?? "",
      )
      if (found) used.push(found.call)
      else if (fill === undefined || !fact) return null
      else unrecorded += 1
      answers[question] = found?.answer ?? { type: "noul", noul: fill }
    }
    for (const call of used)
      if (!this.composedFrom.has(call)) {
        this.composedFrom.add(call)
        this.records.push(call)
      }
    const sources = used.length > 0 ? [...new Set(used)] : this.jevCalls
    const rate =
      sources.reduce((sum, call) => sum + call.costUsd, 0) /
      Math.max(
        1,
        sources.reduce(
          (sum, call) => sum + JSON.stringify(call.request).length,
          0,
        ),
      )
    owner.counts.costUsd += rate * JSON.stringify(body).length
    owner.counts.jev += 1
    owner.counts.jevQuestions += keys.size
    owner.counts.unrecorded += unrecorded
    return Response.json({ answers })
  }
}
