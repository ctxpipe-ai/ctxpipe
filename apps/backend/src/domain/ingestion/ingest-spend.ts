import { sql } from "drizzle-orm"
import { getSystemDb } from "../../db/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import type { IngestStepUsage } from "./ingest-shard-runtime.js"

/*
 * The model spend of an ingestion v2 run. ctxpipe records the spend in the
 * step outputs, the traces and the upgrade records. It does not cap it
 * (ADR-052).
 */

/**
 * USD for one million tokens of the medium tier. The spend converts the
 * reported tokens of a step with it, when the gateway reports no cost. A
 * cache read costs a tenth of an input token (CTX-900): a step that reads
 * its prompt from the cache again on each model call would otherwise look
 * many times too expensive.
 */
const USD_PER_MILLION_TOKENS = { input: 3, cacheRead: 0.3, output: 15 } as const

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
