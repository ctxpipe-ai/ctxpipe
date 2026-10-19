import { sql } from "drizzle-orm"
import { getSystemDb } from "../../db/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import type { IngestStepUsage } from "./ingest-shard-runtime.js"

/*
 * The cost cap of an ingestion v2 run (CTX-897). The cap scales with the
 * size of the repository, and the run checks it before each model step.
 * At the cap, the run starts no new model step, lets the running steps
 * finish, and publishes what is done (`partial`). A later run continues: it
 * skips the roots that are done.
 */

/**
 * USD for one model step at the p90. A run of a large monorepo
 * (2026-10-19) used 3.9M input tokens (3.7M of them cache reads) and 65k
 * output tokens in 43 model steps: about $2.60, or $0.06 for each step, at
 * the fallback prices with the cache rate. The value keeps a margin above
 * that.
 */
const USD_PER_MODEL_STEP = 0.1

/** The cap of one run is in this range (USD). */
export const INGEST_COST_CAP_RANGE = { minUsd: 5, maxUsd: 100 } as const

/**
 * USD for one million tokens of the medium tier. The spend converts the
 * reported tokens of a step with it, when the gateway reports no cost. A
 * cache read costs a tenth of an input token (CTX-900): a step that reads
 * its prompt from the cache again on each model call would otherwise look
 * many times too expensive.
 */
const USD_PER_MILLION_TOKENS = { input: 3, cacheRead: 0.3, output: 15 } as const

/**
 * The cost cap of one ingestion v2 run, in USD:
 *
 *   cap = clamp(2 * modelSteps * $0.10, $5, $100)
 *   modelSteps = roots * (root model skills) + (repository model skills)
 *
 * `roots` is the count of roots that the run does: `discover-roots` finds
 * them before the first model step, so the cap follows the size of the
 * repository. A small repository gets the minimum, so that its first run
 * can finish. The maximum stops a very large repository from spending
 * without bound; it continues in a later run.
 */
export function ingestionCostCapUsd(input: {
  roots: number
  rootModelSkills: number
  repositoryModelSkills: number
}): number {
  const modelSteps =
    input.roots * input.rootModelSkills + input.repositoryModelSkills
  return Math.min(
    INGEST_COST_CAP_RANGE.maxUsd,
    Math.max(INGEST_COST_CAP_RANGE.minUsd, 2 * modelSteps * USD_PER_MODEL_STEP),
  )
}

/** USD of one usage report: the gateway cost, else the tokens at the medium-tier prices. */
export function ingestUsageUsd(usage: IngestStepUsage): number {
  if (typeof usage.costUsd === "number") return usage.costUsd
  const cacheRead = Math.min(usage.cacheReadTokens ?? 0, usage.inputTokens)
  return (
    ((usage.inputTokens - cacheRead) * USD_PER_MILLION_TOKENS.input +
      cacheRead * USD_PER_MILLION_TOKENS.cacheRead +
      usage.outputTokens * USD_PER_MILLION_TOKENS.output) /
    1_000_000
  )
}

/** The ingestion v2 run `runId` and its child runs (the shards), as a `tree(id)` CTE. */
export function ingestionRunTree(runId: string) {
  const namespaceId = openWorkflowNamespaceId()
  return sql`
    with recursive tree(id) as (
      select id from openworkflow.workflow_runs
      where namespace_id = ${namespaceId} and id = ${runId}
      union
      select child.id from openworkflow.workflow_runs child
      join openworkflow.step_attempts parent_step
        on parent_step.namespace_id = child.parent_step_attempt_namespace_id
        and parent_step.id = child.parent_step_attempt_id
      join tree on tree.id = parent_step.workflow_run_id
      where child.namespace_id = ${namespaceId}
    )`
}

function usageUsd(usage: unknown): { usd: number; unknown: boolean } {
  const value = usage as Partial<IngestStepUsage>
  return {
    usd: ingestUsageUsd({
      inputTokens: Number(value.inputTokens) || 0,
      outputTokens: Number(value.outputTokens) || 0,
      cacheReadTokens: Number(value.cacheReadTokens) || 0,
      ...(typeof value.costUsd === "number" ? { costUsd: value.costUsd } : {}),
    }),
    unknown: Number(value.unknownSteps) > 0,
  }
}

/**
 * The model spend in USD of one ingestion v2 run so far: the usage that each
 * finished step of the run and of its child runs reports. `unknown` is true
 * when a model step reported no usage; then `usd` counts only the known part.
 */
export async function ingestionRunSpend(
  runId: string,
): Promise<{ usd: number; unknown: boolean }> {
  const result = await getSystemDb().execute<{ usage: unknown }>(sql`
    ${ingestionRunTree(runId)}
    select attempt.output->'usage' as usage
    from openworkflow.step_attempts attempt
    join tree on tree.id = attempt.workflow_run_id
    where attempt.namespace_id = ${openWorkflowNamespaceId()}
      and attempt.status = 'completed'
      and jsonb_typeof(attempt.output->'usage') = 'object'
  `)
  let usd = 0
  let unknown = false
  for (const { usage } of result.rows) {
    const part = usageUsd(usage)
    usd += part.usd
    if (part.unknown) unknown = true
  }
  return { usd, unknown }
}

/**
 * Whether the run `runId` can start the model step `step` under its cap.
 * The step can start when the spend so far, plus the expected cost of each
 * other skill step that runs now (the shards run in parallel), plus the
 * expected cost of this step, is at most the cap. The expected cost of a
 * step is the mean cost of the finished model steps of the run, and at
 * least $0.10. So the spend passes the cap by at most one step, when a step
 * costs more than expected.
 */
export async function ingestBudgetAllows(input: {
  runId: string
  capUsd: number
  step: string
}): Promise<{ allowed: boolean; spentUsd: number }> {
  const result = await getSystemDb().execute<{
    status: string
    usage: unknown
  }>(sql`
    ${ingestionRunTree(input.runId)}
    select attempt.status, attempt.output->'usage' as usage
    from openworkflow.step_attempts attempt
    join tree on tree.id = attempt.workflow_run_id
    where attempt.namespace_id = ${openWorkflowNamespaceId()}
      and (
        (attempt.status = 'completed'
          and jsonb_typeof(attempt.output->'usage') = 'object')
        or (attempt.status = 'running'
          and attempt.step_name like 'skill:%'
          and attempt.step_name <> ${input.step})
      )
  `)
  let spentUsd = 0
  let finished = 0
  let running = 0
  for (const row of result.rows) {
    if (row.status === "running") {
      running++
      continue
    }
    spentUsd += usageUsd(row.usage).usd
    finished++
  }
  const expected = Math.max(
    USD_PER_MODEL_STEP,
    finished ? spentUsd / finished : 0,
  )
  return {
    allowed: spentUsd + (running + 1) * expected <= input.capUsd,
    spentUsd,
  }
}
