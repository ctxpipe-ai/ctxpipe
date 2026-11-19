// The layer judge of ADR-068 decision 2. For each candidate of one layer of
// the traversal, Jev answers two yes/no questions: p(answers) gives the
// final order, and p(explore) picks the next frontier. Each question asks
// for one judgment. The metadata line stays in the state as context, but no
// question asks Jev to weigh it: code applies the status and the validity
// (ADR-068 decision 2).
import { decideNoul, type JevQuestion, type JevState } from "./client.js"
import {
  type CandidateMeta,
  DATA_PREAMBLE,
  dataBlock,
  metaLine,
} from "./state.js"

/**
 * One candidate: its text, or its image bytes. The caller sends an image
 * that Jev can take (each side from 280 to 1568 px).
 */
export type LayerCandidate = {
  id: string
  meta: CandidateMeta
} & ({ text: string } | { image: { mediaType: string; bytes: Uint8Array } })

type LayerJudgment = { pAnswers: number; pExplore: number }

/**
 * The wording of the two questions about Candidate `n`. The evals of ADR-069
 * tune it.
 */
const QUESTIONS = {
  answers: (n: number) => `Does Candidate ${n} help answer the question?`,
  explore: (n: number) =>
    `Must the search explore the items that are related to Candidate ${n} to answer the question?`,
}

/**
 * Judge the candidates of one layer for the `question`. Returns p(answers)
 * and p(explore) for each candidate id. The candidates go to Jev in batches
 * of at most `batchSize` (CTX-1391 measures the real limit), and the batches
 * run in parallel. Each batch is one Jev call with one span. A failure of
 * any batch throws its `JevError`: this function has no fallback. The ids
 * of the candidates must be different.
 */
export async function judgeLayer({
  question,
  intent,
  candidates,
  batchSize = 25,
  timeoutMs = 30_000,
}: {
  question: string
  /** What the caller wants from the answer, for example "why" or "status". */
  intent: string
  candidates: readonly LayerCandidate[]
  batchSize?: number
  timeoutMs?: number
}): Promise<Map<string, LayerJudgment>> {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer.")
  if (new Set(candidates.map(({ id }) => id)).size !== candidates.length)
    throw new RangeError("Each candidate must have a different id.")
  const batches: LayerCandidate[][] = []
  for (let start = 0; start < candidates.length; start += batchSize)
    batches.push(candidates.slice(start, start + batchSize))

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
        state.push(
          "text" in candidate
            ? dataBlock(candidate.text)
            : {
                type: "image_url",
                image_url: {
                  url: `data:${candidate.image.mediaType};base64,${Buffer.from(candidate.image.bytes).toString("base64")}`,
                },
              },
        )
        questions[`answers.${n}`] = {
          type: "noul",
          instructions: QUESTIONS.answers(n),
        }
        questions[`explore.${n}`] = {
          type: "noul",
          instructions: QUESTIONS.explore(n),
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
        },
      ])
    }),
  )
  return new Map(judged.flat())
}
