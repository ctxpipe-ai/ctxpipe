// The layer judge of ADR-068 decision 2. For each candidate of one layer of
// the traversal, Jev answers two yes/no questions: p(answers) gives the
// final order, and p(explore) picks the next frontier. The search can ask a
// third question, p(states the answer), for its "no answer" (CTX-1685).
// Each question asks
// for one judgment. The metadata line stays in the state, because a
// question about a time needs the dates of a candidate to judge relevance.
// No question asks Jev to weigh the metadata: code applies the status and
// the validity (ADR-068 decision 2).
import { decideNoul, type JevQuestion, type JevState } from "./client.js"
import {
  type CandidateMeta,
  DATA_PREAMBLE,
  dataBlock,
  metaLine,
} from "./state.js"

/** One candidate: its text. An image candidate gives the text of the image. */
export type LayerCandidate = { id: string; meta: CandidateMeta; text: string }

type LayerJudgment = {
  pAnswers: number
  pExplore: number
  /** Only when the call asks it (`statesAnswer`). */
  pStatesAnswer?: number
}

/**
 * The wording of the questions about Candidate `n`. The evals of ADR-069
 * tune it.
 */
const QUESTIONS = {
  answers: (n: number) => `Does Candidate ${n} help answer the question?`,
  explore: (n: number) =>
    `Must the search explore the items that are related to Candidate ${n} to answer the question?`,
  statesAnswer: (n: number) =>
    `Does Candidate ${n} state the answer to the question?`,
}

/**
 * Judge the candidates of one layer for the `question`. Returns p(answers)
 * and p(explore) for each candidate id, and p(states the answer) when
 * `statesAnswer` is true. The candidates go to Jev in batches
 * of at most `batchSize` (CTX-1391 measures the real limit), and the batches
 * run in parallel. Each batch is one Jev call with one span. A failure of
 * any batch throws its `JevError`: this function has no fallback. The ids
 * of the candidates must be different.
 *
 * Jev reads the other candidates of a call, so a candidate can get another
 * judgment in another batch. Thus the batches are cut in the order of the
 * ids, not in the order of the candidates: the same candidates give the
 * same calls in each order. Give ids that do not follow the rank (for
 * example a hash), so that each batch gets strong and weak candidates.
 */
export async function judgeLayer({
  question,
  intent,
  candidates,
  batchSize = 25,
  timeoutMs = 30_000,
  statesAnswer = false,
}: {
  question: string
  /** What the caller wants from the answer, for example "why" or "status". */
  intent: string
  candidates: readonly LayerCandidate[]
  batchSize?: number
  timeoutMs?: number
  /**
   * Also ask if each candidate states the answer. These questions come
   * after the two questions of each candidate, so that the start of the
   * request does not change.
   */
  statesAnswer?: boolean
}): Promise<Map<string, LayerJudgment>> {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer.")
  if (new Set(candidates.map(({ id }) => id)).size !== candidates.length)
    throw new RangeError("Each candidate must have a different id.")
  const ordered = [...candidates].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  const batches: LayerCandidate[][] = []
  for (let start = 0; start < ordered.length; start += batchSize)
    batches.push(ordered.slice(start, start + batchSize))

  const judged = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      const state: JevState = [
        DATA_PREAMBLE,
        `Question: ${dataBlock(question)}`,
        `Intent: ${dataBlock(intent)}`,
      ]
      const questions: Record<string, JevQuestion> = {}
      batch.forEach((candidate, index) => {
        const n = index + 1
        state.push(`Candidate ${n} (${metaLine(candidate.meta)}):`)
        state.push(dataBlock(candidate.text))
        questions[`answers.${n}`] = {
          type: "noul",
          instructions: QUESTIONS.answers(n),
        }
        questions[`explore.${n}`] = {
          type: "noul",
          instructions: QUESTIONS.explore(n),
        }
      })
      if (statesAnswer)
        batch.forEach((_, index) => {
          questions[`states.${index + 1}`] = {
            type: "noul",
            instructions: QUESTIONS.statesAnswer(index + 1),
          }
        })
      const probabilities = await decideNoul(state, questions, {
        timeoutMs,
        attributes: {
          "jev.candidates": batch.length,
          "jev.batch_index": batchIndex,
        },
      })
      return batch.map((candidate, index): [string, LayerJudgment] => [
        candidate.id,
        {
          pAnswers: probabilities.get(`answers.${index + 1}`) ?? 0,
          pExplore: probabilities.get(`explore.${index + 1}`) ?? 0,
          ...(statesAnswer
            ? {
                pStatesAnswer: probabilities.get(`states.${index + 1}`) ?? 0,
              }
            : {}),
        },
      ])
    }),
  )
  return new Map(judged.flat())
}
