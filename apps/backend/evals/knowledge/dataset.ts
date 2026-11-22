import { readFile } from "node:fs/promises"

import { z } from "zod"

import { workspaceRootPathSchema } from "../../src/domain/workspaces/root-path.js"
import { POSITION_STATUSES } from "../../src/retrieval/jev/disagreement.js"

/*
 * The question set of the knowledge-plane evals (ADR-069 decision 5),
 * version 0. A dataset is one JSON file: the corpora, and the questions with
 * their gold labels. The gold labels are paths of documents in the frozen
 * context repo of the corpus.
 */

/** The categories of ADR-069 decision 5. */
export const CATEGORIES = [
  "lookup",
  "multi-hop",
  "cross-source",
  "time",
  "disagreement",
  "image",
  "no-answer",
] as const

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

/** A path in the context repo, as `get_related` accepts it (`checkPath`). */
const path = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment !== "" && segment !== ".."),
    { message: "A path is relative, with no empty or `..` segment." },
  )

const corpusSchema = z.strictObject({
  id,
  /** The public source, for example `kubernetes/enhancements`. */
  source: z.string().min(1),
  /** The frozen context repo: the ingest output of ADR-069 decision 3. */
  contextRepo: z.strictObject({
    url: z.url(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    /**
     * The root folder of the Workspace in the context repo (`""` is the
     * repository root). The gold paths are relative to it, as the tools
     * give them.
     */
    root: workspaceRootPathSchema.default(""),
  }),
  /** The id of the Workspace fixture that holds the context repo. */
  workspace: id,
})

const positionSchema = z.strictObject({
  refs: z.array(path).min(1),
  status: z.enum(POSITION_STATUSES),
})

export const questionSchema = z.strictObject({
  id,
  corpus: id,
  category: z.enum(CATEGORIES),
  /** `dev` to tune with; `holdout` for the keep-or-revert decision only. */
  split: z.enum(["dev", "holdout"]),
  text: z.string().trim().min(1).max(4_000),
  /** The relevant documents. Empty only for `no-answer`. */
  gold: z.array(path),
  /**
   * The start documents of `get_related`. With seeds, the run also measures
   * the traversal recall and, with `positions`, the positions.
   */
  seeds: z.array(path).min(1).max(10).optional(),
  /** The time of the question, for a `time` question. */
  validAt: z.iso.datetime({ offset: true }).optional(),
  /** The expected positions of a `disagreement` question. */
  positions: z.array(positionSchema).optional(),
  /**
   * The stale distractors: archived, retired or superseded copies that also
   * answer the question. They are not gold. The regression check "live
   * first" needs a gold document before each of them in the search.
   */
  stale: z.array(path).min(1).optional(),
  /** The facts that a correct answer holds (the agent-task level). */
  keyFacts: z.array(z.string().min(1)),
})

export type Corpus = z.infer<typeof corpusSchema>
export type Question = z.infer<typeof questionSchema>
export type Position = z.infer<typeof positionSchema>

/**
 * `positions` with each document one time: a document keeps the status of
 * its first position, and the documents of one status form one position.
 */
export function onePositionEach(positions: readonly Position[]): Position[] {
  const byStatus = new Map<Position["status"], string[]>()
  const placed = new Set<string>()
  for (const position of positions)
    for (const ref of position.refs) {
      if (placed.has(ref)) continue
      placed.add(ref)
      byStatus.set(position.status, [
        ...(byStatus.get(position.status) ?? []),
        ref,
      ])
    }
  return [...byStatus].map(([status, refs]) => ({ refs, status }))
}

/** The problems of one question that the field types do not catch. */
export function questionProblems(question: Question): string[] {
  const problems: string[] = []
  const noAnswer = question.category === "no-answer"
  if (noAnswer && question.gold.length > 0)
    problems.push("a no-answer question has no gold document")
  if (!noAnswer && question.gold.length === 0)
    problems.push("the question needs at least one gold document")
  if (!noAnswer && question.keyFacts.length === 0)
    problems.push("the question needs at least one key fact")
  if (question.category === "disagreement") {
    const positions = question.positions ?? []
    const refs = positions.flatMap((position) => position.refs)
    if (!question.seeds)
      problems.push("a disagreement question needs seeds for get_related")
    if (positions.length < 2)
      problems.push("a disagreement question needs at least two positions")
    else {
      // The positions disagree: two or more documents, each in one
      // position, and not all of them current.
      if (new Set(refs).size !== refs.length)
        problems.push("a document is in more than one position")
      if (new Set(refs).size < 2)
        problems.push(
          "a disagreement question needs at least two documents in its positions",
        )
      if (positions.every((position) => position.status === "current"))
        problems.push(
          "a disagreement question needs a position that is not current",
        )
    }
  }
  const gold = new Set(question.gold)
  if (noAnswer && question.stale)
    problems.push("a no-answer question has no stale distractor")
  for (const ref of question.stale ?? [])
    if (gold.has(ref)) problems.push(`stale ref ${ref} is gold`)
  for (const position of question.positions ?? [])
    for (const ref of position.refs)
      if (!gold.has(ref)) problems.push(`position ref ${ref} is not gold`)
  return problems
}

export const datasetSchema = z
  .strictObject({
    version: z.string().min(1),
    corpora: z.array(corpusSchema).min(1),
    questions: z.array(questionSchema).min(1),
  })
  .superRefine((dataset, context) => {
    const corpora = new Set<string>()
    for (const corpus of dataset.corpora) {
      if (corpora.has(corpus.id))
        context.addIssue({
          code: "custom",
          message: `Corpus ${corpus.id} is in the dataset twice.`,
        })
      corpora.add(corpus.id)
    }
    const questions = new Set<string>()
    for (const question of dataset.questions) {
      if (questions.has(question.id))
        context.addIssue({
          code: "custom",
          message: `Question ${question.id} is in the dataset twice.`,
        })
      questions.add(question.id)
      if (!corpora.has(question.corpus))
        context.addIssue({
          code: "custom",
          message: `Question ${question.id} names the unknown corpus ${question.corpus}.`,
        })
      for (const problem of questionProblems(question))
        context.addIssue({
          code: "custom",
          message: `Question ${question.id}: ${problem}.`,
        })
    }
  })

export type Dataset = z.infer<typeof datasetSchema>

/** A frozen dataset before its questions: the input of `draft`. */
export const frozenCorporaSchema = z.object({
  version: z.string().min(1),
  corpora: z.array(corpusSchema).min(1),
})

/** Read and check a dataset file. */
export async function readDataset(file: string): Promise<Dataset> {
  return datasetSchema.parse(JSON.parse(await readFile(file, "utf8")))
}
