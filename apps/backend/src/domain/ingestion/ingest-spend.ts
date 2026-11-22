import { and, eq, sql } from "drizzle-orm"

import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { ingestSandboxThreadId } from "../workspaces/chat-lifecycle.js"
import type { WorkspaceChatCompletionUsage } from "../workspaces/workspace-chat-model-proxy.js"
import type { IngestStepUsage } from "./ingest-shard-runtime.js"

/*
 * The model spend of an ingestion v2 run. ctxpipe records the spend in the
 * step outputs, the traces and the upgrade records. It does not cap it
 * (ADR-052).
 */

/**
 * USD for one million tokens of the medium tier. The spend converts the
 * reported tokens of a call or a step with it only when the gateway reports
 * no cost. These prices can be much higher than the prices of the model in
 * use (CTX-1522), so each such conversion at the model proxy is a log event. A
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

/**
 * The USD of one model call of an ingest step at the model proxy: the
 * gateway cost, else the tokens of the call at the fallback prices
 * (`estimated`). Undefined when the call reports no usage (a failed call).
 */
export function ingestModelCallUsd(
  usage: WorkspaceChatCompletionUsage | null | undefined,
): { usd: number; estimated: boolean } | undefined {
  if (usage?.cost !== undefined) return { usd: usage.cost, estimated: false }
  if (usage?.inputTokens === undefined && usage?.outputTokens === undefined)
    return undefined
  return {
    usd: ingestUsageUsd({
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cachedInputTokens ?? 0,
    }),
    estimated: true,
  }
}

/** The ingest step that holds the shard lock as `lockOwner`. */
type IngestStepLock = {
  orgId: string
  runId: string
  shard: number
  lockOwner: string
}

function heldBy(lock: IngestStepLock) {
  return and(
    eq(sandboxLocks.orgId, lock.orgId),
    eq(sandboxLocks.key, ingestSandboxThreadId(lock.runId, lock.shard)),
    eq(sandboxLocks.owner, lock.lockOwner),
  )
}

/**
 * Add the USD of one model call to the step that holds the shard lock. The
 * lock row keeps it in Postgres, so the model proxy (on the API) and the
 * step (on the worker) share it. Nothing changes when `lockOwner` does not
 * hold the lock now.
 */
export async function addIngestModelCost(
  lock: IngestStepLock,
  usd: number,
): Promise<void> {
  await withOrgDbContext(lock.orgId, (db) =>
    db
      .update(sandboxLocks)
      .set({
        modelCostUsd: sql`coalesce(${sandboxLocks.modelCostUsd}, 0) + ${usd}`,
      })
      .where(heldBy(lock)),
  )
}

/**
 * The USD that the model proxy recorded for the step that holds the shard
 * lock as `lockOwner`. Null when it recorded no call. Read it before the
 * step releases the lock: the release deletes the row.
 */
export async function ingestModelCost(
  lock: IngestStepLock,
): Promise<number | null> {
  const [row] = await withOrgDbContext(lock.orgId, (db) =>
    db
      .select({ usd: sandboxLocks.modelCostUsd })
      .from(sandboxLocks)
      .where(heldBy(lock))
      .limit(1),
  )
  return row?.usd ?? null
}

/**
 * The usage of a step with the cost that the model proxy recorded for it.
 * With no recorded call (`usd` null), the usage stays as the step reported
 * it.
 */
export function withRecordedModelCost(
  usage: IngestStepUsage | undefined,
  usd: number | null,
): IngestStepUsage | undefined {
  if (usd === null) return usage
  return { ...(usage ?? { inputTokens: 0, outputTokens: 0 }), costUsd: usd }
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
