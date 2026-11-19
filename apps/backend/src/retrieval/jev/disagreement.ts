// The query-time disagreement resolver of ADR-068 decision 4. Jev labels each
// pair of evidence items against the question. Items that agree form one
// position. Then Jev gives the status of each position. When Jev is not sure
// of a status, a deterministic tie-break gives it.
import type { KnowledgeRelation } from "../../knowledge-store/knowledge-store.js"
import {
  decideChoice,
  type JevChoiceQuestion,
  JevError,
  type JevState,
} from "./client.js"
import {
  type CandidateMeta,
  DATA_PREAMBLE,
  dataBlock,
  metaLine,
} from "./state.js"

/** One evidence item: a passage, with its metadata and its document key. */
export type EvidenceItem = {
  id: string
  passage: string
  meta: CandidateMeta & { documentKey: string }
}

/** A relation that the store has between the documents of two items. */
type StoredRelation = Pick<KnowledgeRelation, "srcDoc" | "predicate" | "dstDoc">

const PAIR_LABELS = [
  "agrees",
  "contradicts",
  "partial",
  "updates",
  "unrelated",
] as const
type PairLabel = (typeof PAIR_LABELS)[number]

const POSITION_STATUSES = [
  "current",
  "superseded",
  "disputed",
  "scoped",
] as const
type PositionStatus = (typeof POSITION_STATUSES)[number]

/**
 * The source types, from the highest authority to the lowest. The tie-break
 * uses this order, and the state of the status question gives it to Jev. A
 * source type that is not in the list ranks below all of them.
 */
const SOURCE_AUTHORITY_ORDER = [
  "adr",
  "merged-pr",
  "docs",
  "issue",
  "open-pr",
  "chat",
]

/** The wording of the questions to Jev. The evals of ADR-069 tune it. */
const WORDING = {
  pair: (a: number, b: number) =>
    `For the question, how does the claim of Item ${a} relate to the claim of Item ${b}?`,
  pairCriteria: {
    agrees: "The two items make the same claim about the question.",
    contradicts:
      "The two items make claims about the question that cannot both be true.",
    partial:
      "The two items agree on one part of the claim and differ on another part, or each one covers a different scope.",
    updates:
      "One item is a later version of the claim of the other item: it changes or replaces that claim.",
    unrelated:
      "The two items do not make claims about the same part of the question.",
  } satisfies Record<PairLabel, string>,
  status: (n: number) =>
    `What is the status of the claim of Position ${n} for the question? Use the dates, the validity, the source authority and the relations to the other positions as evidence.`,
  statusCriteria: {
    current: "The claim is true at the query time.",
    superseded:
      "A later or more authoritative position replaces the claim, or the claim is not valid at the query time.",
    disputed:
      "Another position contradicts the claim, and the evidence does not show which one is true.",
    scoped:
      "The claim is true only for a part of the question, for example one team, one product or one time range.",
  } satisfies Record<PositionStatus, string>,
}

/**
 * The rule that gave a status when Jev was not sure. The first five are the
 * rules of the tie-break, in order. `no-rival` applies when no other
 * position contradicts, updates or supersedes the position. `tie` applies
 * when no rule decides between the position and a rival.
 */
type TieBreakRule =
  | "supersedes"
  | "validity"
  | "authority"
  | "observed-at"
  | "confidence"
  | "no-rival"
  | "tie"

type Reason =
  | { by: "jev"; probability: number }
  | { by: "tie-break"; rule: TieBreakRule }

/** The result of `resolveDisagreements`. */
type Resolution = {
  /** Each position holds the ids of the items that agree. */
  positions: { itemIds: string[]; status: PositionStatus; reason: Reason }[]
  /**
   * The label of each pair of items in two different positions, with its
   * probability. `positions` holds the indexes of the two positions. The
   * `updates` label has no direction.
   */
  pairs: {
    itemIds: [string, string]
    positions: [number, number]
    label: PairLabel
    probability: number
  }[]
}

/** An item, its number in the state (from 1), and the index of its position. */
type Entry = { item: EvidenceItem; n: number; position: number }

/** The option with the highest probability, the first one on a tie. */
function topOption<Option extends string>(
  options: readonly Option[],
  answers: Map<string, Record<Option, number>>,
  key: string,
): { option: Option; probability: number } {
  const probabilities = answers.get(key)
  // `decide` gives an answer for each question key or throws, so this
  // guard only narrows the type.
  if (!probabilities)
    throw new JevError("invalid-answer", `Jev gave no answer to ${key}.`)
  const option = options.reduce((best, next) =>
    probabilities[next] > probabilities[best] ? next : best,
  )
  return { option, probability: probabilities[option] }
}

/** The time of an ISO 8601 string, or `ifUnknown` for null or a bad date. */
function timeOr(iso: string | null, ifUnknown: number): number {
  const time = iso === null ? Number.NaN : Date.parse(iso)
  return Number.isNaN(time) ? ifUnknown : time
}

/**
 * Resolve the disagreements between the evidence `items` for the
 * `question`, in three steps:
 *
 * 1. One Jev `choice` question for each unordered pair of items gives its
 *    label. The pairs go to Jev in batches of at most `batchSize`, and the
 *    batches run in parallel.
 * 2. The items that are joined by a chain of `agrees` labels form one
 *    position. Each other item is a position of its own.
 * 3. One Jev call asks a `choice` question for each position, with the
 *    relations between the positions in its state. If the top probability
 *    is less than `threshold`, the tie-break gives the status (see
 *    `tieBreak`).
 *
 * The `items` are in rank order, and only the first `maxItems` are used.
 * Their ids must be different. A `relations` entry is evidence when its two
 * documents are the documents of two items. A Jev failure throws its
 * `JevError`: this function has no fallback.
 */
export async function resolveDisagreements({
  question,
  items,
  relations = [],
  queryTime = new Date(),
  maxItems = 10,
  batchSize = 15,
  threshold = 0.5,
  timeoutMs = 30_000,
}: {
  question: string
  items: readonly EvidenceItem[]
  relations?: readonly StoredRelation[]
  queryTime?: Date
  maxItems?: number
  batchSize?: number
  threshold?: number
  timeoutMs?: number
}): Promise<Resolution> {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer.")
  const entries: Entry[] = items
    .slice(0, maxItems)
    .map((item, index) => ({ item, n: index + 1, position: index }))
  if (new Set(entries.map(({ item }) => item.id)).size !== entries.length)
    throw new RangeError("Each item must have a different id.")
  if (entries.length === 0) return { positions: [], pairs: [] }

  const itemText = ({ item, n }: Entry) => [
    `Item ${n} (${metaLine(item.meta)}; document: ${dataBlock(item.meta.documentKey)}):`,
    dataBlock(item.passage),
  ]
  const storedBetween = (among: readonly Entry[]) =>
    relations.flatMap(({ srcDoc, predicate, dstDoc }) =>
      among.flatMap((from) =>
        among.flatMap((to) =>
          from !== to &&
          from.item.meta.documentKey === srcDoc &&
          to.item.meta.documentKey === dstDoc
            ? [{ from, predicate, to }]
            : [],
        ),
      ),
    )
  const header = [
    DATA_PREAMBLE,
    `Question: ${dataBlock(question)}`,
    `Query time: ${queryTime.toISOString()}`,
  ]

  // Step 1: the label of each pair.
  const pairs: { a: Entry; b: Entry; key: string }[] = entries.flatMap(
    (a, index) =>
      entries
        .slice(index + 1)
        .map((b) => ({ a, b, key: `pair.${a.n}.${b.n}` })),
  )
  const batches: (typeof pairs)[] = []
  for (let start = 0; start < pairs.length; start += batchSize)
    batches.push(pairs.slice(start, start + batchSize))
  const labeled = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      const among = entries.filter((entry) =>
        batch.some(({ a, b }) => a === entry || b === entry),
      )
      const state: JevState = [...header, ...among.flatMap(itemText)]
      for (const { from, predicate, to } of storedBetween(among))
        state.push(
          `Stored relation: Item ${from.n} ${dataBlock(predicate)} Item ${to.n}.`,
        )
      const questions: Record<string, JevChoiceQuestion<PairLabel>> = {}
      for (const { a, b, key } of batch)
        questions[key] = {
          type: "choice",
          instructions: WORDING.pair(a.n, b.n),
          criteria: WORDING.pairCriteria,
        }
      const answers = await decideChoice(state, questions, {
        timeoutMs,
        attributes: {
          "jev.pairs": batch.length,
          "jev.batch_index": batchIndex,
        },
      })
      return batch.map(({ a, b, key }) => ({
        a,
        b,
        ...topOption(PAIR_LABELS, answers, key),
      }))
    }),
  )

  // Step 2: positions, as a union-find over the `agrees` pairs. A root is
  // the item of the group with the lowest number.
  const parent = entries.map((_, index) => index)
  const root = (index: number): number => {
    const next = parent[index] ?? index
    return next === index ? index : root(next)
  }
  for (const { a, b, option } of labeled.flat()) {
    if (option !== "agrees") continue
    const [rootA, rootB] = [root(a.n - 1), root(b.n - 1)]
    parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }
  const roots = [...new Set(entries.map((_, index) => root(index)))]
  for (const [index, entry] of entries.entries())
    entry.position = roots.indexOf(root(index))
  const members = roots.map((_, position) =>
    entries.filter((entry) => entry.position === position),
  )
  const crossPairs = labeled
    .flat()
    .filter(({ a, b }) => a.position !== b.position)
  const stored = storedBetween(entries).filter(
    ({ from, to }) => from.position !== to.position,
  )

  // Step 3: the status of each position.
  const ref = ({ n, position }: Entry) => `Item ${n} (Position ${position + 1})`
  const statusKey = (position: number) => `status.${position + 1}`
  const state: JevState = [
    ...header,
    `Source authority, from high to low: ${SOURCE_AUTHORITY_ORDER.join(", ")}.`,
  ]
  for (const [position, member] of members.entries())
    state.push(`Position ${position + 1}:`, ...member.flatMap(itemText))
  state.push("Relations between the positions:")
  for (const { a, b, option, probability } of crossPairs)
    state.push(
      `${ref(a)} and ${ref(b)}: ${option}, probability ${probability.toFixed(2)}.`,
    )
  for (const { from, predicate, to } of stored)
    state.push(
      `Stored relation: ${ref(from)} ${dataBlock(predicate)} ${ref(to)}.`,
    )
  const questions: Record<string, JevChoiceQuestion<PositionStatus>> = {}
  for (const position of members.keys())
    questions[statusKey(position)] = {
      type: "choice",
      instructions: WORDING.status(position + 1),
      criteria: WORDING.statusCriteria,
    }
  const answers = await decideChoice(state, questions, {
    timeoutMs,
    attributes: { "jev.positions": members.length },
  })

  const supersedes = (from: number, to: number) =>
    stored.some(
      (relation) =>
        relation.predicate === "SUPERSEDES" &&
        relation.from.position === from &&
        relation.to.position === to,
    )
  /**
   * The positions that compete with a position: a Jev label `contradicts`
   * or `updates`, or a stored SUPERSEDES in either direction.
   */
  const rivalsOf = (position: number) => [
    ...new Set([
      ...crossPairs.flatMap(({ a, b, option }) => {
        if (option !== "contradicts" && option !== "updates") return []
        if (a.position === position) return [b.position]
        if (b.position === position) return [a.position]
        return []
      }),
      ...members.flatMap((_, other) =>
        other !== position &&
        (supersedes(position, other) || supersedes(other, position))
          ? [other]
          : [],
      ),
    ]),
  ]
  const now = queryTime.getTime()
  const isValid = ({ meta }: EvidenceItem) =>
    timeOr(meta.validFrom, -Infinity) <= now &&
    now < timeOr(meta.validTo, Infinity)
  /** The rules after `supersedes`, in order, as a value to maximize. */
  const ruleValues: [TieBreakRule, (item: EvidenceItem) => number][] = [
    ["validity", (item) => Number(isValid(item))],
    [
      "authority",
      ({ meta }) => {
        const rank = SOURCE_AUTHORITY_ORDER.indexOf(meta.sourceType)
        return rank === -1 ? -SOURCE_AUTHORITY_ORDER.length : -rank
      },
    ],
    ["observed-at", ({ meta }) => timeOr(meta.observedAt, -Infinity)],
    ["confidence", ({ meta }) => meta.confidence ?? -1],
  ]
  const bestOfPosition = (
    position: number,
    value: (item: EvidenceItem) => number,
  ) => Math.max(...(members[position] ?? []).map(({ item }) => value(item)))
  /**
   * Compare a position with a rival, rule by rule. Returns the first rule
   * that decides, with 1 when the position wins and -1 when the rival wins.
   * Returns `tie` with 0 when no rule decides.
   */
  const compare = (
    position: number,
    rival: number,
  ): { rule: TieBreakRule; result: -1 | 0 | 1 } => {
    const mine = supersedes(position, rival)
    if (mine !== supersedes(rival, position))
      return { rule: "supersedes", result: mine ? 1 : -1 }
    for (const [rule, value] of ruleValues) {
      const [own, theirs] = [
        bestOfPosition(position, value),
        bestOfPosition(rival, value),
      ]
      if (own !== theirs) return { rule, result: own > theirs ? 1 : -1 }
    }
    return { rule: "tie", result: 0 }
  }
  /**
   * The status of a position when Jev is not sure. A rival that a stored
   * SUPERSEDES replaces is superseded first, and it does not compete with
   * the other positions: the stored relations are not in the scalar order
   * of the later rules, so without this step a loop of rivals can make each
   * position superseded. A position that loses to a competing rival is
   * superseded. A position that ties with one is disputed. A position with
   * no item valid at the query time is superseded when an item has expired,
   * and scoped when its items are valid only later. Else the position is
   * current. The reason is the rule of the first rival that gives the
   * status.
   */
  const replacedByStored = (position: number) =>
    rivalsOf(position).some(
      (rival) => supersedes(rival, position) && !supersedes(position, rival),
    )
  const tieBreak = (
    position: number,
  ): { status: PositionStatus; rule: TieBreakRule } => {
    if (replacedByStored(position))
      return { status: "superseded", rule: "supersedes" }
    const results = rivalsOf(position).map((rival) => ({
      rival,
      ...compare(position, rival),
    }))
    const competing = results.filter(
      ({ result, rival }) => result === 1 || !replacedByStored(rival),
    )
    const lost = competing.find(({ result }) => result === -1)
    if (lost) return { status: "superseded", rule: lost.rule }
    const tied = competing.find(({ result }) => result === 0)
    if (tied) return { status: "disputed", rule: tied.rule }
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
    return { status: "current", rule: results[0]?.rule ?? "no-rival" }
  }

  return {
    positions: members.map((member, position) => {
      const jev = topOption(POSITION_STATUSES, answers, statusKey(position))
      const itemIds = member.map(({ item }) => item.id)
      if (jev.probability >= threshold)
        return {
          itemIds,
          status: jev.option,
          reason: { by: "jev", probability: jev.probability },
        }
      const { status, rule } = tieBreak(position)
      return { itemIds, status, reason: { by: "tie-break", rule } }
    }),
    pairs: crossPairs.map(({ a, b, option, probability }) => ({
      itemIds: [a.item.id, b.item.id],
      positions: [a.position, b.position],
      label: option,
      probability,
    })),
  }
}
