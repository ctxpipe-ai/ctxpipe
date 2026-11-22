import { connectorMirrorRoot } from "../../src/domain/codeIngestion/connectorMirrorPaths.js"
import { markdownLines } from "../../src/domain/workspaces/knowledge-chunks.js"
import { measureResult } from "../../src/mcp/framework/budget.js"
import type { Question } from "./dataset.js"
import { ARMS, type Arm, type ArmAnswer, type SearchPage } from "./runner.js"

/*
 * The regression checks of CTX-1518: the failures of the Falkor retrieval
 * that the production reviews found (CTX-1131, CTX-1114), and that recall
 * and nDCG do not show. Each check reads only the kept answers and needs no
 * model call. Checks 1 to 3 and 8 read the first page of `search_knowledge`
 * that a client gets (`SearchPage`), so a run from before CTX-1518 has no
 * value for them.
 */

export const CHECKS = [
  "duplicateSlots",
  "headingOnlyHits",
  "botBestChunk",
  "hubSlots",
  "liveFirst",
  "noAnswerSeparation",
  "coldSearchMs",
  "coldRelatedMs",
  "pageBytes",
] as const
export type Check = (typeof CHECKS)[number]

/** Null when no answer of the arm gives the check an input. */
export type CheckValues = Record<Check, number | null>

export const CHECK_INFO: Record<
  Check,
  {
    name: string
    better: "lower" | "higher"
    unit: "share" | "count" | "ms" | "bytes"
  }
> = {
  duplicateSlots: {
    name: "1. second copies of an item on the first page (share of slots)",
    better: "lower",
    unit: "share",
  },
  headingOnlyHits: {
    name: "2. first-page hits whose snippet holds only headings",
    better: "lower",
    unit: "count",
  },
  botBestChunk: {
    name: "3. GitHub hits whose best chunk is a bot comment (share)",
    better: "lower",
    unit: "share",
  },
  hubSlots: {
    name: "4. get_related top-10 slots that hold a hub with no gold label (share)",
    better: "lower",
    unit: "share",
  },
  liveFirst: {
    name: "5. live document before each stale copy (share of questions)",
    better: "higher",
    unit: "share",
  },
  noAnswerSeparation: {
    name: "6. top score of a true hit above the top score of a no-answer question (AUC)",
    better: "higher",
    unit: "share",
  },
  coldSearchMs: {
    name: "7. cold first search",
    better: "lower",
    unit: "ms",
  },
  coldRelatedMs: {
    name: "7. cold first get_related",
    better: "lower",
    unit: "ms",
  },
  pageBytes: {
    name: "8. bytes of the first page (mean)",
    better: "lower",
    unit: "bytes",
  },
}

/** The slots of `get_related` that check 4 reads, as nDCG@10 reads 10 refs. */
const RELATED_SLOTS = 10

type PageHit = SearchPage["hits"][number]

/**
 * The source item of a hit (check 1). A connector mirror writes the title of
 * the item into each copy of it (CTX-1132: one Linear issue at three paths),
 * so an item of a mirror is its connector and its title. Another document is
 * its path.
 */
function itemKey(hit: PageHit): string {
  const root = connectorMirrorRoot(hit.ref)
  const title = hit.title?.trim().toLowerCase()
  return root && title ? `${root}\0${title}` : `path\0${hit.ref}`
}

/**
 * The section lines of a snippet. A chunk text starts with the title and
 * the heading path on one line, then a blank line (`knowledgeChunkRows`).
 */
function sectionLines(snippet: string) {
  const lines = markdownLines(snippet)
  const context =
    lines[0]?.heading === null &&
    lines[1] !== undefined &&
    !lines[1].line.trim()
  return (context ? lines.slice(2) : lines).filter(({ line }) => line.trim())
}

/** Check 2 (CTX-1133): each line of the section is a heading. */
export function isHeadingOnly(snippet: string): boolean {
  return sectionLines(snippet).every(({ heading }) => heading !== null)
}

/**
 * Check 3 (CTX-1140): the last heading of the chunk is a comment or a review
 * of a bot. The GitHub mirrors write `<time> · <login> (bot)` for a comment
 * and `<login> (bot) — <state>` for a review (`actorLine`).
 */
export function isBotComment(snippet: string): boolean {
  const context = snippet.split("\n", 1)[0] ?? ""
  return /(?:^|> |· )\S+ \(bot\)(?: — \S+)?$/.test(context)
}

/** `part` divided by `total`, or null when `total` is 0. */
const ratio = (part: number, total: number) => (total ? part / total : null)

/**
 * Check 6: the probability that the top score of a true hit (the first ref
 * is gold) is above the top score of a no-answer question, with half for a
 * tie (the AUC). The arms have scores of different scales (RRF and Jev's
 * p(answers)), so a rank measure compares them, not a distance. A search
 * with no hit has the lowest score. 0.5: the score gives no signal.
 */
function separation(
  answered: readonly number[],
  unanswerable: readonly number[],
): number | null {
  if (answered.length === 0 || unanswerable.length === 0) return null
  let wins = 0
  for (const a of answered)
    for (const u of unanswerable) wins += a > u ? 1 : a === u ? 0.5 : 0
  return wins / (answered.length * unanswerable.length)
}

/**
 * Check 4 (CTX-1135): a hub is a document that an arm returns from
 * `get_related` for many questions of a corpus, also when it is not their
 * gold: in the top 10 of at least a quarter of the questions with seeds of
 * the corpus, and of at least 3. A node that links to almost every service
 * comes back for each seed, so its count is high. The value is the share of
 * the top-10 slots (without the seeds of the question) that hold a hub that
 * is not gold for the question.
 */
function hubSlots(
  answers: readonly { question: Question; related: string[] }[],
): number | null {
  const byCorpus = Map.groupBy(answers, (answer) => answer.question.corpus)
  let slots = 0
  let hubs = 0
  for (const group of byCorpus.values()) {
    const counts = new Map<string, number>()
    for (const { related } of group)
      for (const ref of new Set(related))
        counts.set(ref, (counts.get(ref) ?? 0) + 1)
    const least = Math.max(3, Math.ceil(group.length / 4))
    for (const { question, related } of group) {
      slots += related.length
      hubs += related.filter(
        (ref) =>
          (counts.get(ref) ?? 0) >= least && !question.gold.includes(ref),
      ).length
    }
  }
  return ratio(hubs, slots)
}

/**
 * The checks of each arm. `scored` are the answers that the report scores.
 * Check 7 reads `answers` in the order of the run: the first search and the
 * first `get_related` of each arm on each corpus are the calls after the
 * quiet time before the run. Its value is the slowest corpus.
 */
export function regressionChecks(input: {
  questions: ReadonlyMap<string, Question>
  answers: readonly ArmAnswer[]
  scored: readonly ArmAnswer[]
}): Record<Arm, CheckValues> {
  const result = {} as Record<Arm, CheckValues>
  for (const arm of ARMS) {
    const asked = (answers: readonly ArmAnswer[]) =>
      answers.flatMap((answer) => {
        const question = input.questions.get(answer.question)
        return answer.arm === arm && question ? [{ answer, question }] : []
      })
    const scored = asked(input.scored)
    const searches = scored.flatMap(({ answer, question }) =>
      "error" in answer.search ? [] : [{ search: answer.search, question }],
    )
    const pages = searches.flatMap(({ search }) =>
      search.page ? [search.page] : [],
    )
    const hits = pages.flatMap((page) => page.hits)
    const github = hits.filter(
      (hit) => connectorMirrorRoot(hit.ref) === "github",
    )
    const duplicates = pages.flatMap((page) => {
      const seen = new Set<string>()
      return page.hits.filter((hit) => {
        const key = itemKey(hit)
        const copy = seen.has(key)
        seen.add(key)
        return copy
      })
    })
    const stale = searches.filter(({ question }) => question.stale)
    const firstOf = (refs: readonly string[], of: readonly string[]) => {
      const rank = refs.findIndex((ref) => of.includes(ref))
      return rank === -1 ? Number.POSITIVE_INFINITY : rank
    }
    const topScore = (search: { scores: number[] }) =>
      search.scores[0] ?? Number.NEGATIVE_INFINITY
    const related = scored.flatMap(({ answer, question }) =>
      question.seeds && answer.related && !("error" in answer.related)
        ? [
            {
              question,
              related: answer.related.refs
                .filter((ref) => !question.seeds?.includes(ref))
                .slice(0, RELATED_SLOTS),
            },
          ]
        : [],
    )
    const cold = (pick: (answer: ArmAnswer) => number | undefined) => {
      const first = new Map<string, number>()
      for (const { answer, question } of asked(input.answers)) {
        const ms = pick(answer)
        if (ms !== undefined && !first.has(question.corpus))
          first.set(question.corpus, ms)
      }
      return first.size ? Math.max(...first.values()) : null
    }
    result[arm] = {
      duplicateSlots: ratio(duplicates.length, hits.length),
      headingOnlyHits: pages.length
        ? hits.filter((hit) => isHeadingOnly(hit.snippet)).length
        : null,
      botBestChunk: ratio(
        github.filter((hit) => isBotComment(hit.snippet)).length,
        github.length,
      ),
      hubSlots: hubSlots(related),
      liveFirst: ratio(
        stale.filter(
          ({ search, question }) =>
            firstOf(search.refs, question.gold) <
            firstOf(search.refs, question.stale ?? []),
        ).length,
        stale.length,
      ),
      noAnswerSeparation: separation(
        searches
          .filter(
            ({ search, question }) =>
              question.category !== "no-answer" &&
              question.gold.includes(search.refs[0] ?? ""),
          )
          .map(({ search }) => topScore(search)),
        searches
          .filter(({ question }) => question.category === "no-answer")
          .map(({ search }) => topScore(search)),
      ),
      coldSearchMs: cold((answer) => answer.search.latencyMs),
      coldRelatedMs: cold((answer) => answer.related?.latencyMs),
      pageBytes: ratio(
        pages.reduce(
          (sum, page) => sum + Buffer.byteLength(measureResult(page).text),
          0,
        ),
        pages.length,
      ),
    }
  }
  return result
}
