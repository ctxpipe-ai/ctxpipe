import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import type { KnowledgeReader } from "../../src/knowledge-reader/knowledge-reader.js"
import { legacyKnowledgeReader } from "../../src/knowledge-reader/legacy-reader.js"
import { ORCHESTRATOR_DEFAULTS } from "../../src/knowledge-reader/orchestrator.js"
import { planeKnowledgeReader } from "../../src/knowledge-reader/plane-reader.js"
import { resolveCallWorkspace } from "../../src/mcp/framework/call-workspace.js"
import { McpToolError } from "../../src/mcp/framework/tool-errors.js"
import { getRelatedInputShape } from "../../src/mcp/tools/get-related.js"
import { readyKnowledgeShas } from "../../src/models/knowledge-state.js"
import type { Dataset, Position, Question } from "./dataset.js"
import type { CallCounts, ModelCalls, RecordedCall } from "./model-calls.js"

/*
 * One eval run (ADR-069 decision 7): each question of the dataset, through
 * each arm, through the `KnowledgeReader` seam of the tools. Each arm gets
 * the same Workspace, the same question and the same request, so the
 * comparison is fair.
 *
 * The agent-task level of ADR-069 decision 6 (CTX-1117) comes later. It
 * reads the answers of `answers.jsonl`, or it adds one more step to `ask`.
 */

/** The arms of ADR-069 decision 1. The first one is the baseline arm. */
export const ARMS = ["legacy", "plane"] as const
export type Arm = (typeof ARMS)[number]

export const ARM_NAMES: Record<Arm, string> = {
  legacy: "baseline: current stack (Postgres + FalkorDB)",
  plane: "knowledge plane (ClickHouse + Jev)",
}

/** The search of each question asks for this many hits (search recall@50). */
export const SEARCH_LIMIT = 50

/** The Workspace of a corpus fixture id, in the database of the run. */
export const targetsSchema = z.record(
  z.string(),
  z.strictObject({
    orgId: z.string().min(1),
    orgSlug: z.string().min(1),
    workspace: z.string().min(1),
  }),
)
export type Targets = z.infer<typeof targetsSchema>

/** The settings of the retrieval loop that a run can change. */
export type Settings = Partial<
  Record<keyof typeof ORCHESTRATOR_DEFAULTS, number>
>

/**
 * Parse `name=value` overrides of `ORCHESTRATOR_DEFAULTS`. A run changes one
 * setting (ADR-069 decision 7).
 */
export function parseSettings(values: readonly string[]): Settings {
  const settings: Settings = {}
  for (const value of values) {
    const [name, number] = value.split("=")
    if (!name || !Object.hasOwn(ORCHESTRATOR_DEFAULTS, name))
      throw new Error(
        `Unknown setting "${name}". Use one of: ${Object.keys(ORCHESTRATOR_DEFAULTS).join(", ")}.`,
      )
    const parsed = Number(number)
    if (!Number.isFinite(parsed))
      throw new Error(`The setting ${name} needs a number.`)
    settings[name as keyof Settings] = parsed
  }
  return settings
}

/** Apply `settings` to the loop. Call the result to restore the defaults. */
export function applySettings(settings: Settings): () => void {
  const before = { ...ORCHESTRATOR_DEFAULTS }
  Object.assign(ORCHESTRATOR_DEFAULTS, settings)
  return () => {
    Object.assign(ORCHESTRATOR_DEFAULTS, before)
  }
}

type Ranked = {
  refs: string[]
  scores: number[]
  partialReason?: string
  latencyMs: number
}

/** The answer of one arm to one question. */
export type ArmAnswer = {
  arm: Arm
  question: string
  search: Ranked | { error: string; latencyMs: number }
  /** Only for a question with seeds. */
  related?:
    | (Ranked & { positions?: Position[] })
    | { error: string; latencyMs: number }
  calls: CallCounts
  /** Replay only: the recording did not hold each call of this answer. */
  incomplete?: true
}

/** The facts of a run, for the report and for `rescore`. */
export type Manifest = {
  datasetVersion: string
  arms: Arm[]
  splits: ("dev" | "holdout")[]
  /** The query time of each question, so that a replay sends the same requests. */
  now: string
  settings: Settings
  /** The effective settings of the loop. */
  loop: typeof ORCHESTRATOR_DEFAULTS
  mode: "live" | "replay"
  capUsd: number
  spentUsd: number
  stopped: boolean
}

/** The kind of a failure, for the answer. */
function failure(error: unknown): string {
  if (error instanceof McpToolError) return error.code
  return error instanceof Error ? error.name : "unknown"
}

const relatedInput = z.object(getRelatedInputShape)

/** The Workspace of each corpus, with the SHA that each stack serves. */
async function resolveWorkspaces(dataset: Dataset, targets: Targets) {
  const resolved = new Map<
    string,
    {
      org: { id: string; slug: string }
      workspace: { id: string; slug: string }
      legacySha: string
      planeSha: string | undefined
    }
  >()
  for (const corpus of dataset.corpora) {
    const target = targets[corpus.workspace]
    if (!target)
      throw new Error(
        `The targets file has no Workspace for ${corpus.workspace}.`,
      )
    const org = { id: target.orgId, slug: target.orgSlug }
    const workspace = await resolveCallWorkspace(org, target.workspace)
    if (!workspace.served)
      throw new Error(
        `Workspace ${target.workspace} has no published revision.`,
      )
    const shas = await readyKnowledgeShas(org.id, [workspace.id])
    resolved.set(corpus.id, {
      org,
      workspace: { id: workspace.id, slug: workspace.slug },
      legacySha: workspace.served.sha,
      planeSha: shas.get(workspace.id),
    })
  }
  return resolved
}

/**
 * Run each question of `questions` through each arm, one after the other, so
 * that each latency is the latency of one request. Stops at the spend cap of
 * `calls`; the answer that the cap stopped is not kept.
 */
export async function runEval(input: {
  dataset: Dataset
  questions: readonly Question[]
  targets: Targets
  arms: readonly Arm[]
  calls: ModelCalls
  now: Date
}): Promise<ArmAnswer[]> {
  const { calls, now } = input
  const workspaces = await resolveWorkspaces(input.dataset, input.targets)
  const answers: ArmAnswer[] = []
  for (const question of input.questions) {
    const target = workspaces.get(question.corpus)
    if (!target) throw new Error(`No Workspace for ${question.corpus}.`)
    for (const arm of input.arms) {
      const sha = arm === "legacy" ? target.legacySha : target.planeSha
      if (!sha)
        throw new Error(
          `Workspace ${target.workspace.slug} is not ready on the knowledge plane.`,
        )
      const reader: KnowledgeReader =
        arm === "legacy"
          ? legacyKnowledgeReader
          : planeKnowledgeReader({
              shas: new Map([[target.workspace.id, sha]]),
            })
      calls.begin(arm, question.id)
      const answer = await ask(reader, question, target, sha, now)
      const counts = calls.end()
      if (calls.stopped) return answers
      answers.push({
        arm,
        question: question.id,
        ...answer,
        calls: counts,
        ...(counts.missing > 0 ? { incomplete: true as const } : {}),
      })
    }
  }
  return answers
}

/** The search, then `get_related` from the seeds, of one question. */
async function ask(
  reader: KnowledgeReader,
  question: Question,
  target: {
    org: { id: string; slug: string }
    workspace: { id: string; slug: string }
  },
  sha: string,
  now: Date,
): Promise<Pick<ArmAnswer, "search" | "related">> {
  const validAt = question.validAt ? new Date(question.validAt) : undefined
  let started = performance.now()
  let search: ArmAnswer["search"]
  try {
    const result = await reader.search({
      orgId: target.org.id,
      workspaceIds: [target.workspace.id],
      query: question.text,
      limit: SEARCH_LIMIT,
      ...(validAt ? { validAt } : {}),
    })
    search = {
      refs: result.hits.map((hit) => hit.path),
      scores: result.hits.map((hit) => hit.score),
      ...(result.partialReason ? { partialReason: result.partialReason } : {}),
      latencyMs: performance.now() - started,
    }
  } catch (error) {
    search = { error: failure(error), latencyMs: performance.now() - started }
  }
  if (!question.seeds) return { search }
  started = performance.now()
  let related: ArmAnswer["related"]
  try {
    const ranking = await reader.related({
      org: target.org,
      workspace: target.workspace,
      sha,
      input: relatedInput.parse({
        workspace: target.workspace.slug,
        seeds: question.seeds,
        query: question.text,
        intent: question.intent ?? "general",
        validAt: (validAt ?? now).toISOString(),
        // A seed can hold one of the positions. The traversal recall
        // counts only the gold documents that are not seeds.
        includeSeeds: true,
      }),
      now,
    })
    related = {
      refs: ranking.results.map((result) => result.ref),
      scores: ranking.results.map((result) => result.score),
      ...(ranking.positions
        ? {
            positions: ranking.positions.map(({ refs, status }) => ({
              refs,
              status,
            })),
          }
        : {}),
      ...(ranking.partialReason
        ? { partialReason: ranking.partialReason }
        : {}),
      latencyMs: performance.now() - started,
    }
  } catch (error) {
    related = { error: failure(error), latencyMs: performance.now() - started }
  }
  return { search, related }
}

const jsonl = (rows: readonly unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "")

const readJsonl = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)

/**
 * The run folder: `manifest.json`, the dataset and the targets of the run,
 * `answers.jsonl` (the arm outputs) and `calls.jsonl` (each model request
 * and its raw answer).
 */
export async function writeRun(
  folder: string,
  run: {
    manifest: Manifest
    dataset: Dataset
    targets: Targets
    answers: readonly ArmAnswer[]
    calls: readonly RecordedCall[]
  },
): Promise<void> {
  await mkdir(folder, { recursive: true })
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  await writeFile(join(folder, "manifest.json"), json(run.manifest))
  await writeFile(join(folder, "dataset.json"), json(run.dataset))
  await writeFile(join(folder, "targets.json"), json(run.targets))
  await writeFile(join(folder, "answers.jsonl"), jsonl(run.answers))
  await writeFile(join(folder, "calls.jsonl"), jsonl(run.calls))
}

/** Read a run folder that `writeRun` wrote. */
export async function readRun(folder: string) {
  const json = async (name: string) =>
    JSON.parse(await readFile(join(folder, name), "utf8")) as unknown
  return {
    manifest: (await json("manifest.json")) as Manifest,
    dataset: (await json("dataset.json")) as Dataset,
    targets: targetsSchema.parse(await json("targets.json")),
    answers: await readJsonl<ArmAnswer>(join(folder, "answers.jsonl")),
    calls: await readJsonl<RecordedCall>(join(folder, "calls.jsonl")),
  }
}
