// The query-time disagreement step of ADR-068 decision 4. Jev answers small
// yes/no facts about the content of each pair of evidence items and of each
// item. Code reads the facts as readings between two items. It gives no
// verdict on an item: the client agent reasons about the readings, with the
// stored relations, the sources and the times.
import { decideNoul, type JevQuestion, type JevState } from "./client.js"
import { DATA_PREAMBLE, dataBlock } from "./state.js"

/** One evidence item: a passage. */
export type EvidenceItem = { id: string; passage: string }

/**
 * The readings of the model between two items, as predicates of a claim
 * from one item to the other:
 * - `REPLACES`: the claim of the first item changes or replaces the claim
 *   of the second item;
 * - `CONTRADICTS`: the claims disagree;
 * - `PARTLY_CONTRADICTS`: the claims disagree, and only the claim of the
 *   first item applies only to a part of the question.
 */
export const READINGS = [
  "REPLACES",
  "CONTRADICTS",
  "PARTLY_CONTRADICTS",
] as const
type ReadingPredicate = (typeof READINGS)[number]

/** One reading of the model, from one item to another. */
export type Reading = {
  from: string
  to: string
  predicate: ReadingPredicate
  /** The lowest p(yes) of the facts that give the reading. */
  confidence: number
}

/**
 * The yes/no questions to Jev. Each one asks for one judgment about the
 * content, and "yes" means that the condition is present. The row data
 * (dates, validity, source authority, stored relations, confidence) is not
 * in the state: code applies it. The evals of ADR-069 tune the wording.
 */
const QUESTIONS = {
  same: (a: number, b: number) =>
    `Do Item ${a} and Item ${b} make a claim about the same part of the question?`,
  disagree: (a: number, b: number) =>
    `Do the claims of Item ${a} and Item ${b} disagree?`,
  replaces: (from: number, to: number) =>
    `Does Item ${from} change or replace the claim of Item ${to}?`,
  scoped: (n: number) =>
    `Does the claim of Item ${n} apply only to a part of the question, for example one team, one product or one time range?`,
}

/**
 * The pair facts whose meaning does not depend on the order of the two
 * items. Each pair gets them once, with the lower number first, and an eval
 * replay reads them in either order of the items.
 */
export const SYMMETRIC_FACTS = ["same", "disagree"] as const

/**
 * The names of all facts, the first part of each question key. An eval
 * replay can fill an unrecorded fact (`--unrecorded-yes`), and no other
 * question.
 */
export const DISAGREEMENT_FACTS = [
  ...SYMMETRIC_FACTS,
  "replaces",
  "scoped",
] as const

/** The question keys of the facts. Jev answers each key with p(yes). */
const KEYS = {
  same: (a: number, b: number) => `same.${a}.${b}`,
  disagree: (a: number, b: number) => `disagree.${a}.${b}`,
  replaces: (from: number, to: number) => `replaces.${from}.${to}`,
  scoped: (n: number) => `scoped.${n}`,
}

/** A fact is "yes" when its probability is at least its threshold. */
type FactThresholds = {
  sameAt: number
  disagreeAt: number
  replacesAt: number
  scopedAt: number
}

/** The time of a Date or an ISO 8601 string, or `ifUnknown` for null or a bad date. */
function timeOr(value: Date | string | null, ifUnknown: number): number {
  const time =
    value === null
      ? Number.NaN
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value)
  return Number.isNaN(time) ? ifUnknown : time
}

/** The default number of pairs in one Jev call. */
const BATCH_SIZE = 12

/** True when the span is valid at `at`. An unknown bound is open. */
export function isValidAt(
  span: { validFrom: Date | string | null; validTo: Date | string | null },
  at: Date,
): boolean {
  const now = at.getTime()
  return (
    timeOr(span.validFrom, -Infinity) <= now &&
    now < timeOr(span.validTo, Infinity)
  )
}

/**
 * The number of Jev calls that `askDisagreementFacts` makes for `items`
 * items with the default batch size: one call for each batch of
 * `BATCH_SIZE` pairs.
 */
export function disagreementCalls(items: number): number {
  return Math.ceil((items * (items - 1)) / 2 / BATCH_SIZE)
}

/**
 * The yes/no facts that Jev gave about some items: p(yes) for each question
 * key, with the items numbered from 1 in the order of `itemIds`.
 */
export type DisagreementFacts = {
  itemIds: readonly string[]
  answers: ReadonlyMap<string, number>
}

/**
 * Ask Jev the facts about the evidence `items` for the `question`. One Jev
 * call for each batch of at most `batchSize` pairs asks four yes/no facts
 * for each pair of the batch (same part of the question, disagree, and
 * "changes or replaces" in each direction), and the `scoped` fact for each
 * item that no earlier batch asked about. The batches run in parallel. With
 * fewer than two items, there is no pair and no reading, so no call goes
 * out.
 *
 * The ids of the items must be different. A Jev failure throws its
 * `JevError`: this function has no fallback.
 */
export async function askDisagreementFacts({
  question,
  items,
  batchSize = BATCH_SIZE,
  timeoutMs = 30_000,
}: {
  question: string
  items: readonly EvidenceItem[]
  batchSize?: number
  timeoutMs?: number
}): Promise<DisagreementFacts> {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer.")
  if (new Set(items.map(({ id }) => id)).size !== items.length)
    throw new RangeError("Each item must have a different id.")
  const itemIds = items.map(({ id }) => id)
  if (items.length < 2) return { itemIds, answers: new Map() }

  const numbers = items.map((_, index) => index + 1)
  const pairs = numbers.flatMap((a) =>
    numbers.filter((b) => b > a).map((b): [number, number] => [a, b]),
  )
  const batches: { pairs: [number, number][]; scoped: number[] }[] = []
  for (let start = 0; start < pairs.length; start += batchSize)
    batches.push({ pairs: pairs.slice(start, start + batchSize), scoped: [] })
  for (const n of numbers)
    (
      batches.find((batch) => batch.pairs.some((pair) => pair.includes(n))) ??
      batches[0]
    )?.scoped.push(n)

  const answers = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      const among = numbers.filter(
        (n) =>
          batch.scoped.includes(n) ||
          batch.pairs.some((pair) => pair.includes(n)),
      )
      const state: JevState = [
        DATA_PREAMBLE,
        `Question: ${dataBlock(question)}`,
        ...among.flatMap((n) => [
          `Item ${n}:`,
          dataBlock(items[n - 1]?.passage ?? ""),
        ]),
      ]
      const questions: Record<string, JevQuestion> = {}
      const ask = (key: string, instructions: string) => {
        questions[key] = { type: "noul", instructions }
      }
      for (const [a, b] of batch.pairs) {
        ask(KEYS.same(a, b), QUESTIONS.same(a, b))
        ask(KEYS.disagree(a, b), QUESTIONS.disagree(a, b))
        ask(KEYS.replaces(a, b), QUESTIONS.replaces(a, b))
        ask(KEYS.replaces(b, a), QUESTIONS.replaces(b, a))
      }
      for (const n of batch.scoped) ask(KEYS.scoped(n), QUESTIONS.scoped(n))
      return decideNoul(state, questions, {
        timeoutMs,
        attributes: {
          "jev.pairs": batch.pairs.length,
          "jev.questions": Object.keys(questions).length,
          "jev.batch_index": batchIndex,
        },
      })
    }),
  )
  return {
    itemIds,
    answers: new Map(answers.flatMap((answer) => [...answer])),
  }
}

/**
 * The facts of `items` from `facts`, with the items numbered from 1 in
 * their own order, as `readDisagreements` reads them. Each item must be
 * one that the facts are about.
 */
function factsOf(
  facts: DisagreementFacts,
  items: readonly EvidenceItem[],
): Map<string, number> {
  const asked = items.map(({ id }) => {
    const index = facts.itemIds.indexOf(id)
    if (index < 0)
      throw new RangeError(`The facts are not about the item ${id}.`)
    return index + 1
  })
  const out = new Map<string, number>()
  const copy = (to: string, from: string) => {
    const value = facts.answers.get(from)
    if (value !== undefined) out.set(to, value)
  }
  asked.forEach((n, index) => {
    const a = index + 1
    copy(KEYS.scoped(a), KEYS.scoped(n))
    asked.slice(index + 1).forEach((m, offset) => {
      const b = a + offset + 1
      // A symmetric fact is asked once for each pair, with the lower number
      // first.
      const [low, high] = n < m ? [n, m] : [m, n]
      for (const fact of SYMMETRIC_FACTS)
        copy(KEYS[fact](a, b), KEYS[fact](low, high))
      copy(KEYS.replaces(a, b), KEYS.replaces(n, m))
      copy(KEYS.replaces(b, a), KEYS.replaces(m, n))
    })
  })
  return out
}

/**
 * Read the disagreements between the evidence `items` for the `question`:
 * ask Jev the facts (`askDisagreementFacts`), then `readDisagreements`
 * gives the readings. With `facts` (an earlier ask about a set of items that
 * holds each of `items`), no call goes out.
 *
 * The `items` are in rank order, and only the first `maxItems` are used.
 * Their ids must be different. A Jev failure throws its `JevError`: this
 * function has no fallback.
 */
export async function disagreementReadings({
  question,
  items,
  facts,
  thresholds,
  maxItems = 10,
  batchSize = BATCH_SIZE,
  timeoutMs = 30_000,
}: {
  question: string
  items: readonly EvidenceItem[]
  facts?: DisagreementFacts
  thresholds: FactThresholds
  maxItems?: number
  batchSize?: number
  timeoutMs?: number
}): Promise<Reading[]> {
  const used = items.slice(0, maxItems)
  const asked =
    facts ??
    (await askDisagreementFacts({
      question,
      items: used,
      batchSize,
      timeoutMs,
    }))
  if (used.length === 0) return []
  return readDisagreements({
    items: used,
    facts: factsOf(asked, used),
    thresholds,
  })
}

/**
 * The readings between the `items` from the Jev `facts` (p(yes) for each
 * question key of `askDisagreementFacts`). It makes no call, so that the
 * evals can score a change of this logic or of a threshold again from the
 * recorded answers. A missing fact is "no".
 *
 * A pair whose claims are not about the same part of the question, or that
 * agree, has no reading. Else:
 * - `REPLACES` from Item a to Item b, for each direction where Item a
 *   changes or replaces the claim of Item b;
 * - else, when the claims disagree: `PARTLY_CONTRADICTS` from the item whose
 *   claim applies only to a part of the question, when only one item has
 *   that fact, else `CONTRADICTS` from the item of the higher rank.
 *
 * The readings are in the order of the pairs, so the items of a higher rank
 * come first.
 */
export function readDisagreements({
  items,
  facts,
  thresholds,
}: {
  items: readonly EvidenceItem[]
  facts: ReadonlyMap<string, number>
  thresholds: FactThresholds
}): Reading[] {
  const p = (key: string) => facts.get(key) ?? 0
  const yes = (key: string, at: number) => p(key) >= at
  const scoped = (n: number) => yes(KEYS.scoped(n), thresholds.scopedAt)
  const numbered = items.map((item, index) => ({ id: item.id, n: index + 1 }))
  return numbered.flatMap((a, index) =>
    numbered.slice(index + 1).flatMap((b): Reading[] => {
      const same = p(KEYS.same(a.n, b.n))
      if (same < thresholds.sameAt) return []
      const replaces = (
        [
          [a, b],
          [b, a],
        ] as const
      ).flatMap(([from, to]): Reading[] => {
        const replacesP = p(KEYS.replaces(from.n, to.n))
        if (replacesP < thresholds.replacesAt) return []
        return [
          {
            from: from.id,
            to: to.id,
            predicate: "REPLACES",
            confidence: Math.min(same, replacesP),
          },
        ]
      })
      if (replaces.length > 0) return replaces
      const disagree = p(KEYS.disagree(a.n, b.n))
      if (disagree < thresholds.disagreeAt) return []
      if (scoped(a.n) === scoped(b.n))
        return [
          {
            from: a.id,
            to: b.id,
            predicate: "CONTRADICTS",
            confidence: Math.min(same, disagree),
          },
        ]
      const [part, other] = scoped(a.n) ? [a, b] : [b, a]
      return [
        {
          from: part.id,
          to: other.id,
          predicate: "PARTLY_CONTRADICTS",
          confidence: Math.min(same, disagree, p(KEYS.scoped(part.n))),
        },
      ]
    }),
  )
}
