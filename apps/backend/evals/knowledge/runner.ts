import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import { withOrgDbContext } from "../../src/db/client.js"
import { workspaceRevisionSchema } from "../../src/domain/workspaces/revision.js"
import { workspaceRootPath } from "../../src/domain/workspaces/root-path.js"
import { knowledgeProjectionRoot } from "../../src/knowledge-plane/change-set.js"
import type { KnowledgeReader } from "../../src/knowledge-reader/knowledge-reader.js"
import { legacyKnowledgeReader } from "../../src/knowledge-reader/legacy-reader.js"
import { ORCHESTRATOR_DEFAULTS } from "../../src/knowledge-reader/orchestrator.js"
import { planeKnowledgeReader } from "../../src/knowledge-reader/plane-reader.js"
import { resolveCallWorkspace } from "../../src/mcp/framework/call-workspace.js"
import { McpToolError } from "../../src/mcp/framework/tool-errors.js"
import { getRelatedInputShape } from "../../src/mcp/tools/get-related.js"
import {
  getKnowledgeState,
  readyKnowledgeShas,
} from "../../src/models/knowledge-state.js"
import { getWorkspaceById } from "../../src/models/workspaces.js"
import { POSITION_STATUSES } from "../../src/retrieval/jev/disagreement.js"
import { type Dataset, datasetSchema, type Question } from "./dataset.js"
import {
  callCountsSchema,
  type ModelCalls,
  type RecordedCall,
  recordedCallSchema,
} from "./model-calls.js"

/*
 * One eval run (ADR-069 decision 7): each question of the dataset, through
 * both arms, through the `KnowledgeReader` seam of the tools. Both arms get
 * the same Workspace, at the frozen SHA of the corpus, the same question and
 * the same request, so the comparison is fair.
 *
 * The agent-task level of ADR-069 decision 6 (CTX-1117) comes later. It
 * reads the answers of `answers.jsonl`, or it adds one more step to `ask`.
 */

/**
 * The two arms (a CTO decision): the baseline, which is the current stack,
 * and the knowledge plane. Only the plane has Jev's p(answers) as its score
 * and gives positions.
 */
export const ARMS = ["legacy", "plane"] as const
export type Arm = (typeof ARMS)[number]

export const ARM_NAMES: Record<Arm, string> = {
  legacy: "baseline: current stack (Postgres + FalkorDB)",
  plane: "knowledge plane (ClickHouse + Jev)",
}

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
 * Parse the `name=value` override of `ORCHESTRATOR_DEFAULTS`. A run changes
 * one setting (ADR-069 decision 7), so that the report shows the effect of
 * that change only.
 */
export function parseSettings(values: readonly string[]): Settings {
  if (values.length > 1)
    throw new Error("A run changes one setting. Give --set one time only.")
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

/** A call that failed: the kind of the failure, and its latency. */
const callFailureSchema = z.object({ error: z.string(), latencyMs: z.number() })

const rankedSchema = z.object({
  refs: z.array(z.string()),
  scores: z.array(z.number()),
  partialReason: z.string().optional(),
  latencyMs: z.number(),
})

/** The answer of one arm to one question (`answers.jsonl`). */
const armAnswerSchema = z.object({
  arm: z.enum(ARMS),
  question: z.string(),
  search: z.union([rankedSchema, callFailureSchema]),
  /** Only for a question with seeds. */
  related: z
    .union([
      rankedSchema.extend({
        positions: z
          .array(
            z.object({
              refs: z.array(z.string()),
              status: z.enum(POSITION_STATUSES),
            }),
          )
          .optional(),
      }),
      callFailureSchema,
    ])
    .optional(),
  /** In a replay, `calls.missing` counts the calls that the recording lacks. */
  calls: callCountsSchema,
})
export type ArmAnswer = z.infer<typeof armAnswerSchema>

/** The facts of a run, for the report and for `rescore` (`manifest.json`). */
const manifestSchema = z.object({
  datasetVersion: z.string(),
  splits: z.array(z.enum(["dev", "holdout"])),
  /** The query time of each question, so that a replay sends the same requests. */
  now: z.iso.datetime(),
  settings: z.record(z.string(), z.number()),
  /** The effective settings of the loop. */
  loop: z.object({ keepAt: z.number() }).catchall(z.number()),
  mode: z.enum(["live", "replay"]),
  capUsd: z.number(),
  spentUsd: z.number(),
  stopped: z.boolean(),
})
export type Manifest = z.infer<typeof manifestSchema>

/** The kind of a failure, for the answer. */
function failure(error: unknown): string {
  if (error instanceof McpToolError) return error.code
  return error instanceof Error ? error.name : "unknown"
}

const relatedInput = z.object(getRelatedInputShape)

/** The org and the Workspace of a corpus, and the SHA that both stacks serve. */
type EvalTarget = {
  org: { id: string; slug: string }
  workspace: { id: string; slug: string }
  sha: string
}

/**
 * The Workspace of each corpus. Both stacks must serve the frozen SHA of the
 * corpus, so that both arms read the same context repo that the gold labels
 * describe (ADR-069 decision 4).
 */
async function resolveWorkspaces(
  dataset: Dataset,
  targets: Targets,
): Promise<Map<string, EvalTarget>> {
  const resolved = new Map<string, EvalTarget>()
  for (const corpus of dataset.corpora) {
    const target = targets[corpus.workspace]
    if (!target)
      throw new Error(
        `The targets file has no Workspace for ${corpus.workspace}.`,
      )
    const org = { id: target.orgId, slug: target.orgSlug }
    const workspace = await resolveCallWorkspace(org, target.workspace)
    const plane = (await readyKnowledgeShas(org.id, [workspace.id])).get(
      workspace.id,
    )
    const { sha, root } = corpus.contextRepo
    if (workspace.served?.sha !== sha || plane !== sha)
      throw new Error(
        `Workspace ${workspace.slug} must serve the frozen SHA ${sha} of ${corpus.id} on both stacks. The old stack serves ${workspace.served?.sha ?? "nothing"}, and the plane serves ${plane ?? "nothing"}.`,
      )
    // The gold paths are relative to the root of the corpus, as the tools
    // give the paths of the Workspace. Each stack must serve that root: a
    // failed projection after a change of the root keeps the earlier one.
    const record = await withOrgDbContext(org.id, () =>
      getWorkspaceById(workspace.id, org.id),
    )
    const state = await getKnowledgeState({
      orgId: org.id,
      workspaceId: workspace.id,
    })
    const roots = {
      workspace: workspaceRootPath(record),
      old: workspaceRootPath(
        workspaceRevisionSchema.safeParse(record?.activeRevision).data,
      ),
      plane: state?.projectionVersion
        ? knowledgeProjectionRoot(state.projectionVersion)
        : null,
    }
    if (Object.values(roots).some((served) => served !== root))
      throw new Error(
        `Workspace ${workspace.slug} must serve the root "${root}" of ${corpus.id} on both stacks. The Workspace has "${roots.workspace}", the old stack serves "${roots.old}", and the plane serves "${roots.plane ?? "an unknown root"}".`,
      )
    resolved.set(corpus.id, {
      org,
      workspace: { id: workspace.id, slug: workspace.slug },
      sha,
    })
  }
  return resolved
}

/**
 * Run each question of `questions` through both arms, one after the other,
 * so that each latency is the latency of one request. Stops at the spend
 * cap of `calls`; the answer that the cap stopped is not kept.
 */
export async function runEval(input: {
  dataset: Dataset
  questions: readonly Question[]
  targets: Targets
  calls: ModelCalls
  now: Date
}): Promise<ArmAnswer[]> {
  const { calls, now } = input
  const workspaces = await resolveWorkspaces(input.dataset, input.targets)
  const answers: ArmAnswer[] = []
  for (const question of input.questions) {
    const target = workspaces.get(question.corpus)
    if (!target) throw new Error(`No Workspace for ${question.corpus}.`)
    for (const arm of ARMS) {
      const reader: KnowledgeReader =
        arm === "legacy"
          ? legacyKnowledgeReader
          : planeKnowledgeReader({
              shas: new Map([[target.workspace.id, target.sha]]),
            })
      calls.begin(arm, question.id)
      const answer = await ask(reader, question, target, now)
      await calls.settle()
      const counts = calls.end()
      if (calls.stopped) return answers
      answers.push({
        arm,
        question: question.id,
        ...answer,
        calls: counts,
      })
    }
  }
  return answers
}

/** The search, then `get_related` from the seeds, of one question. */
async function ask(
  reader: KnowledgeReader,
  question: Question,
  target: EvalTarget,
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
      // The most that a search gives: search recall@50 reads all of it.
      limit: 50,
      ...(validAt ? { validAt } : {}),
      now,
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
      sha: target.sha,
      input: relatedInput.parse({
        workspace: target.workspace.slug,
        seeds: question.seeds,
        query: question.text,
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

/** Write `value` as indented JSON. */
export const writeJson = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`)

/** Read a JSON file. */
export const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, "utf8"))

const jsonl = (rows: readonly unknown[]) =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("")

const readJsonl = async <T>(file: string, schema: z.ZodType<T>) =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)))

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
  await writeJson(join(folder, "manifest.json"), run.manifest)
  await writeJson(join(folder, "dataset.json"), run.dataset)
  await writeJson(join(folder, "targets.json"), run.targets)
  await writeFile(join(folder, "answers.jsonl"), jsonl(run.answers))
  await writeFile(join(folder, "calls.jsonl"), jsonl(run.calls))
}

/** Read and check a run folder that `writeRun` wrote. */
export async function readRun(folder: string) {
  return {
    manifest: manifestSchema.parse(
      await readJson(join(folder, "manifest.json")),
    ),
    dataset: datasetSchema.parse(await readJson(join(folder, "dataset.json"))),
    targets: targetsSchema.parse(await readJson(join(folder, "targets.json"))),
    answers: await readJsonl(join(folder, "answers.jsonl"), armAnswerSchema),
    calls: await readJsonl(join(folder, "calls.jsonl"), recordedCallSchema),
  }
}
