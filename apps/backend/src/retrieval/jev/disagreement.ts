// The query-time disagreement resolver of ADR-068 decision 4. Jev answers
// small yes/no facts about the content of each pair of evidence items and of
// each item. Code decides the rest from these facts and from the row data:
// the label of each pair, the positions (the items that agree), and the
// status of each position.
import { SOURCE_AUTHORITY_ORDER } from "../../knowledge-plane/rows.js"
import type { KnowledgeRelation } from "../../knowledge-store/knowledge-store.js"
import { decideNoul, type JevQuestion, type JevState } from "./client.js"
import { type CandidateMeta, DATA_PREAMBLE, dataBlock } from "./state.js"

/** One evidence item: a passage, with its metadata and its document key. */
export type EvidenceItem = {
  id: string
  passage: string
  meta: CandidateMeta & { documentKey: string }
}

/** A relation that the store has between the documents of two items. */
type StoredRelation = Pick<KnowledgeRelation, "srcDoc" | "predicate" | "dstDoc">

type PairLabel = "agrees" | "contradicts" | "partial" | "updates" | "unrelated"

export const POSITION_STATUSES = [
  "current",
  "superseded",
  "disputed",
  "scoped",
] as const
type PositionStatus = (typeof POSITION_STATUSES)[number]

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

/**
 * The rule that gave a status, in the order that `decideDisagreements`
 * applies them. `no-rival` applies when no other position contradicts,
 * updates or supersedes the position. `tie` applies when no rule decides
 * between the position and a rival.
 */
export const STATUS_RULES = [
  "supersedes",
  "updates",
  "validity",
  "authority",
  "observed-at",
  "confidence",
  "scoped",
  "no-rival",
  "tie",
] as const
export type StatusRule = (typeof STATUS_RULES)[number]

/** The result of `resolveDisagreements`. */
type Resolution = {
  /**
   * Each position holds the ids of the items that agree. The rules of code
   * give each status; `by` keeps the name of the earlier tie-break, so that
   * the output keeps its shape.
   */
  positions: {
    itemIds: string[]
    status: PositionStatus
    reason: { by: "tie-break"; rule: StatusRule }
  }[]
  /**
   * The label of each pair of items in two different positions.
   * `positions` holds the indexes of the two positions. The `updates` label
   * has no direction.
   */
  pairs: {
    itemIds: [string, string]
    positions: [number, number]
    label: PairLabel
  }[]
}

/** An item, its number in the state (from 1), and the index of its position. */
type Entry = { item: EvidenceItem; n: number; position: number }

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
 * The number of Jev calls that `resolveDisagreements` makes for `items`
 * items with the default batch size: one call for each batch of
 * `BATCH_SIZE` pairs, and at least one.
 */
export function disagreementCalls(items: number): number {
  return Math.max(1, Math.ceil((items * (items - 1)) / 2 / BATCH_SIZE))
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
 * item that no earlier batch asked about. The batches run in parallel. A
 * single item gets one call with its `scoped` fact only. No item: no call.
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
  if (items.length === 0) return { itemIds, answers: new Map() }

  const numbers = items.map((_, index) => index + 1)
  const pairs = numbers.flatMap((a) =>
    numbers.filter((b) => b > a).map((b): [number, number] => [a, b]),
  )
  const batches: { pairs: [number, number][]; scoped: number[] }[] = []
  for (let start = 0; start < pairs.length; start += batchSize)
    batches.push({ pairs: pairs.slice(start, start + batchSize), scoped: [] })
  if (batches.length === 0) batches.push({ pairs: [], scoped: [] })
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
 * their own order, as `decideDisagreements` reads them. Each item must be
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
 * Resolve the disagreements between the evidence `items` for the
 * `question`: ask Jev the facts (`askDisagreementFacts`), then
 * `decideDisagreements` decides the labels, the positions and the statuses.
 * With `facts` (an earlier ask about a set of items that holds each of
 * `items`), no call goes out.
 *
 * The `items` are in rank order, and only the first `maxItems` are used.
 * Their ids must be different. A Jev failure throws its `JevError`: this
 * function has no fallback.
 */
export async function resolveDisagreements({
  question,
  items,
  facts,
  relations = [],
  queryTime = new Date(),
  thresholds,
  maxItems = 10,
  batchSize = BATCH_SIZE,
  timeoutMs = 30_000,
}: {
  question: string
  items: readonly EvidenceItem[]
  facts?: DisagreementFacts
  relations?: readonly StoredRelation[]
  queryTime?: Date
  thresholds: FactThresholds
  maxItems?: number
  batchSize?: number
  timeoutMs?: number
}): Promise<Resolution> {
  const used = items.slice(0, maxItems)
  const asked =
    facts ??
    (await askDisagreementFacts({
      question,
      items: used,
      batchSize,
      timeoutMs,
    }))
  if (used.length === 0) return { positions: [], pairs: [] }
  return decideDisagreements({
    items: used,
    facts: factsOf(asked, used),
    relations,
    queryTime,
    thresholds,
  })
}

/**
 * Decide the labels, the positions and the statuses from the Jev `facts`
 * (p(yes) for each question key of `resolveDisagreements`) and the row data
 * of the `items`. It makes no call, so that the evals can score a change of
 * this logic or of a threshold again from the recorded answers. A missing
 * fact is "no".
 *
 * 1. **The label of each pair** (Item a, Item b):
 *    - a stored SUPERSEDES between the documents of the two items:
 *      `updates`, whatever Jev's facts are, also when Jev says that the
 *      claims are about different parts of the question;
 *    - not the same part of the question: `unrelated`;
 *    - one item changes or replaces the claim of the other: `updates`;
 *    - the claims do not disagree: `agrees`;
 *    - they disagree, and the claim of only one item applies to a part of
 *      the question: `partial`;
 *    - else `contradicts`.
 * 2. **Positions:** the items that are joined by a chain of `agrees` labels
 *    form one position. Each other item is a position of its own. Two items
 *    whose own pair is `contradicts` or `updates` are never in one
 *    position: a chain does not join their groups, whatever a third item
 *    agrees with. The pairs join in their order, so the items of a higher
 *    rank join first.
 * 3. **The status of each position**, with the first rule that decides:
 *    - A rival replaces it (`supersedes`: a stored SUPERSEDES; `updates`:
 *      Jev's `updates` in one direction only): superseded. A position that
 *      is replaced this way does not compete with the other positions: the
 *      relations are not in the scalar order of the later rules, so without
 *      this step a loop of rivals can make each position superseded.
 *    - No item is valid at the query time (`validity`): superseded when an
 *      item has expired, else scoped (valid only later).
 *    - It loses to a competing rival on the first rule that decides
 *      (`supersedes`, `updates`, `validity`, `authority`, `observed-at`,
 *      `confidence`): superseded. It ties with one (`tie`): disputed.
 *    - Each valid item has the `scoped` fact (`scoped`): scoped.
 *    - Else current, with the rule of the first rival, or `no-rival`.
 *
 *    A rival is a position with a `contradicts` or `updates` label to the
 *    position. After `validity`, only the valid items of a position count,
 *    so that a later rule does not use the metadata of an expired item.
 */
export function decideDisagreements({
  items,
  facts,
  relations,
  queryTime,
  thresholds,
}: {
  items: readonly EvidenceItem[]
  facts: ReadonlyMap<string, number>
  relations: readonly StoredRelation[]
  queryTime: Date
  thresholds: FactThresholds
}): Resolution {
  const yes = (key: string, at: number) => (facts.get(key) ?? 0) >= at
  const scoped = (n: number) => yes(KEYS.scoped(n), thresholds.scopedAt)
  const entries: Entry[] = items.map((item, index) => ({
    item,
    n: index + 1,
    position: index,
  }))

  // Step 1: the label of each pair. `replacer` is the item that changes or
  // replaces the claim of the other, when only one does.
  const storedSupersedes = (from: Entry, to: Entry) =>
    relations.some(
      ({ srcDoc, predicate, dstDoc }) =>
        predicate === "SUPERSEDES" &&
        srcDoc === from.item.meta.documentKey &&
        dstDoc === to.item.meta.documentKey,
    )
  const labeled = entries.flatMap((a, index) =>
    entries.slice(index + 1).map((b) => {
      const label = (): { label: PairLabel; replacer?: Entry } => {
        // A stored SUPERSEDES is a fact of the store, so it decides before
        // Jev's facts (CTX-1684). Else Jev can read the same plan in both
        // records, and the two items join one position. The label makes
        // the pair a rival pair; the rule `supersedes` gives the direction.
        if (storedSupersedes(a, b) || storedSupersedes(b, a))
          return { label: "updates" }
        if (!yes(KEYS.same(a.n, b.n), thresholds.sameAt))
          return { label: "unrelated" }
        const aReplaces = yes(KEYS.replaces(a.n, b.n), thresholds.replacesAt)
        const bReplaces = yes(KEYS.replaces(b.n, a.n), thresholds.replacesAt)
        if (aReplaces || bReplaces)
          return aReplaces === bReplaces
            ? { label: "updates" }
            : { label: "updates", replacer: aReplaces ? a : b }
        if (!yes(KEYS.disagree(a.n, b.n), thresholds.disagreeAt))
          return { label: "agrees" }
        return {
          label: scoped(a.n) !== scoped(b.n) ? "partial" : "contradicts",
        }
      }
      return { a, b, ...label() }
    }),
  )

  // Step 2: positions, as a union-find over the `agrees` pairs, in the
  // order of the pairs. A root is the item of the group with the lowest
  // number. Two groups do not join when a pair across them is a rival pair
  // (`contradicts` or `updates`): else a third item that agrees with both
  // items of a rival pair puts them in one position.
  const parent = entries.map((_, index) => index)
  const root = (index: number): number => {
    const next = parent[index] ?? index
    return next === index ? index : root(next)
  }
  const rivalPairs = labeled.filter(
    ({ label }) => label === "contradicts" || label === "updates",
  )
  for (const { a, b, label } of labeled) {
    if (label !== "agrees") continue
    const [rootA, rootB] = [root(a.n - 1), root(b.n - 1)]
    if (rootA === rootB) continue
    const across = (x: Entry, y: Entry) =>
      root(x.n - 1) === rootA && root(y.n - 1) === rootB
    if (rivalPairs.some(({ a: x, b: y }) => across(x, y) || across(y, x)))
      continue
    parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }
  const roots = [...new Set(entries.map((_, index) => root(index)))]
  for (const [index, entry] of entries.entries())
    entry.position = roots.indexOf(root(index))
  const members = roots.map((_, position) =>
    entries.filter((entry) => entry.position === position),
  )
  const crossPairs = labeled.filter(({ a, b }) => a.position !== b.position)

  // Step 3: the status of each position.
  const supersedes = (from: number, to: number) =>
    (members[from] ?? []).some((x) =>
      (members[to] ?? []).some((y) => storedSupersedes(x, y)),
    )
  const updates = (from: number, to: number) =>
    crossPairs.some(
      ({ a, b, replacer }) =>
        replacer?.position === from && (replacer === a ? b : a).position === to,
    )
  /**
   * The positions that compete with a position: a label `contradicts` or
   * `updates`. A stored SUPERSEDES gives its pair the label `updates`.
   */
  const rivalsOf = (position: number) => [
    ...new Set(
      crossPairs.flatMap(({ a, b, label }) => {
        if (label !== "contradicts" && label !== "updates") return []
        if (a.position === position) return [b.position]
        if (b.position === position) return [a.position]
        return []
      }),
    ),
  ]
  const now = queryTime.getTime()
  const isValid = ({ meta }: EvidenceItem) => isValidAt(meta, queryTime)
  /** The items of a position that count: the valid ones, if it has any. */
  const counted = (position: number) => {
    const all = members[position] ?? []
    const valid = all.filter(({ item }) => isValid(item))
    return valid.length > 0 ? valid : all
  }
  /** The rules after `updates`, in order, as a value to maximize. */
  const ruleValues: [StatusRule, (item: EvidenceItem) => number][] = [
    ["validity", (item) => Number(isValid(item))],
    [
      "authority",
      ({ meta }) => {
        const rank = (SOURCE_AUTHORITY_ORDER as readonly string[]).indexOf(
          meta.sourceType,
        )
        return rank === -1 ? -SOURCE_AUTHORITY_ORDER.length : -rank
      },
    ],
    ["observed-at", ({ meta }) => timeOr(meta.observedAt, -Infinity)],
    ["confidence", ({ meta }) => meta.confidence ?? -1],
  ]
  type Comparison = { rule: StatusRule; result: -1 | 0 | 1 }
  /**
   * The relation rules: 1 when the position replaces the rival, -1 when the
   * rival replaces the position. Null when no relation decides.
   */
  const byRelation = (position: number, rival: number): Comparison | null => {
    for (const [rule, replaces] of [
      ["supersedes", supersedes],
      ["updates", updates],
    ] as const) {
      const mine = replaces(position, rival)
      if (mine !== replaces(rival, position))
        return { rule, result: mine ? 1 : -1 }
    }
    return null
  }
  /** Compare a position with a rival, rule by rule. */
  const compare = (position: number, rival: number): Comparison => {
    const relation = byRelation(position, rival)
    if (relation) return relation
    for (const [rule, value] of ruleValues) {
      const best = (of: number) =>
        Math.max(...counted(of).map(({ item }) => value(item)))
      const [own, theirs] = [best(position), best(rival)]
      if (own !== theirs) return { rule, result: own > theirs ? 1 : -1 }
    }
    return { rule: "tie", result: 0 }
  }
  const replacedBy = (position: number) =>
    rivalsOf(position)
      .map((rival) => byRelation(position, rival))
      .find((relation) => relation?.result === -1)
  const statusOf = (
    position: number,
  ): { status: PositionStatus; rule: StatusRule } => {
    const replaced = replacedBy(position)
    if (replaced) return { status: "superseded", rule: replaced.rule }
    const member = members[position] ?? []
    if (!member.some(({ item }) => isValid(item)))
      return {
        status: member.some(
          ({ item }) => timeOr(item.meta.validTo, Infinity) <= now,
        )
          ? "superseded"
          : "scoped",
        rule: "validity",
      }
    const results = rivalsOf(position).map((rival) => ({
      rival,
      ...compare(position, rival),
    }))
    const competing = results.filter(
      ({ result, rival }) => result === 1 || !replacedBy(rival),
    )
    const lost = competing.find(({ result }) => result === -1)
    if (lost) return { status: "superseded", rule: lost.rule }
    const tied = competing.find(({ result }) => result === 0)
    if (tied) return { status: "disputed", rule: tied.rule }
    if (counted(position).every(({ n }) => scoped(n)))
      return { status: "scoped", rule: "scoped" }
    return { status: "current", rule: results[0]?.rule ?? "no-rival" }
  }

  return {
    positions: members.map((member, position) => {
      const { status, rule } = statusOf(position)
      return {
        itemIds: member.map(({ item }) => item.id),
        status,
        reason: { by: "tie-break", rule },
      }
    }),
    pairs: crossPairs.map(({ a, b, label }) => ({
      itemIds: [a.item.id, b.item.id],
      positions: [a.position, b.position],
      label,
    })),
  }
}
