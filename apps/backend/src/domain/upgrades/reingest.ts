import { gunzipSync } from "node:zlib"
import { and, eq, sql } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import type { IngestStepUsage } from "../ingestion/ingest-shard-runtime.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  plannedIngestSkills,
} from "../ingestion/ingestion-plan.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { ingestionV2EnabledFor } from "../ingestion/ingestion-v2-config.js"
import { lockedSandboxProvider } from "../workspaces/sandbox-provider.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import {
  type EstimateRange,
  type ReingestEstimate,
  UPGRADE_BLOCKED_REASONS,
  type UpgradeBlockedReason,
} from "./registry.js"

/*
 * The fresh re-ingestion upgrade (ADR-053 section 5, CTO decision G1). It
 * runs ingestion v2 again for each GitHub source repository of a Workspace.
 * An owner or admin starts it after the UI shows the estimate. Nothing
 * starts it automatically.
 */

/** The re-ingestion needs this format or higher (G5). */
export const REINGEST_REQUIRES_FORMAT = 3

const REINGEST_KEY_PREFIX = "reingest-"

/**
 * The throttle of re-ingestion (ADR-052): one upgrade run of an org at a
 * time, with its repositories one after the other, and a cap of upgrade runs
 * on the instance. The polls back off from `firstPoll`, so a long wait
 * spends few workflow steps.
 */
export const REINGEST_THROTTLE = {
  /** Upgrade runs (each one org) that run their repositories at a time on this instance. */
  runsPerInstance: 4,
  firstPollSeconds: 60,
  /** The longest wait of the upgrade run for its turn. */
  maxSlotPollSeconds: 15 * 60,
  /** The longest wait of a repository run between two reads of its ingestion run and spend. */
  maxRunPollSeconds: 5 * 60,
}

/** The wait before poll `poll` (from 0): it doubles from `first` up to `max`. */
export function reingestPollSeconds(
  poll: number,
  first: number,
  max: number,
): number {
  return Math.min(max, first * 2 ** Math.min(poll, 30))
}

/**
 * The calibration of the estimate when a repository has no ingestion v2
 * history. The per-step cost is a range for one model step of the medium
 * tier. Change these values when the measured spend changes.
 */
const ESTIMATE = {
  rootsWithoutHistory: { low: 1, high: 8 },
  usdPerModelStep: { low: 0.04, high: 0.12 },
  minutesPerModelStep: { low: 1, high: 3 },
  /** Index, discovery, assemble and publish. */
  setupMinutes: { low: 3, high: 8 },
  /** Shards that run at the same time (`SHARD_BATCH` of the v2 workflow). */
  parallelShards: 4,
  /**
   * USD for one million tokens of the medium tier. The cost cap converts
   * the reported tokens of a step with it, when the gateway reports no cost.
   */
  usdPerMillionTokens: { input: 3, output: 15 },
} as const

/** The key of the re-ingestion with a skill bundle (`ingest-<hash>`). */
export function reingestUpgradeKey(bundleName: string): string {
  return `${REINGEST_KEY_PREFIX}${bundleName}`
}

export function isReingestUpgradeKey(key: string): boolean {
  return key.startsWith(REINGEST_KEY_PREFIX)
}

/**
 * Why this deployment cannot run an ingest sandbox, or null. Ingest needs a
 * Docker sandbox host now; the hosted Vercel path waits for its egress proxy
 * (`shardSandbox` in `ingest-shard-sandbox.ts`).
 */
export function ingestSandboxUnavailable(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const provider = lockedSandboxProvider(env) ?? "docker"
  if (provider === "docker") return null
  return provider === "unsandboxed"
    ? "Re-ingestion needs a Docker sandbox host. This deployment runs agents unsandboxed."
    : `Re-ingestion needs a Docker sandbox host. Ingest does not run on the ${provider} sandbox provider yet.`
}

export type ReingestRepository = {
  /** `owner/name`. */
  repository: string
  url: string
  githubConnectionId: string
}

/**
 * The GitHub source repositories of a Workspace: each repository of a valid
 * GitHub source (`status` ok), once, sorted. Call it outside an org
 * transaction.
 */
export async function workspaceSourceRepositories(
  orgId: string,
  workspaceId: string,
): Promise<ReingestRepository[]> {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        connectionId: workspaceSources.connectionId,
        scope: workspaceSources.scope,
      })
      .from(workspaceSources)
      .where(
        and(
          eq(workspaceSources.workspaceId, workspaceId),
          eq(workspaceSources.provider, "github"),
          eq(workspaceSources.status, "ok"),
        ),
      ),
  )
  const found = new Map<string, ReingestRepository>()
  for (const row of rows) {
    const names = (row.scope as { repositories?: unknown }).repositories
    if (!row.connectionId || !Array.isArray(names)) continue
    for (const name of names) {
      if (typeof name !== "string") continue
      const url = normalizeWorkspaceRepositoryUrl(`https://github.com/${name}`)
      const repository = githubRepoFullNameFromWorkspaceUrl(url)
      if (!repository || found.has(repository.toLowerCase())) continue
      found.set(repository.toLowerCase(), {
        repository,
        url,
        githubConnectionId: row.connectionId,
      })
    }
  }
  return [...found.values()].sort((a, b) =>
    a.repository < b.repository ? -1 : 1,
  )
}

const round = (value: number, digits: number) =>
  Math.round(value * 10 ** digits) / 10 ** digits

/**
 * The estimate of a re-ingestion (ADR-053 section 5). For each repository,
 * the root count and the wall time come from its last finished ingestion v2
 * run, when it has one. Without one, the root count is a committed range.
 * The cost is the model steps (roots times the root skills, plus the
 * repository skills of the bundle) times the per-step cost range. The run
 * records no spend in the database, so the cost has no history.
 */
export async function estimateReingest(input: {
  orgId: string
  repositories: readonly ReingestRepository[]
  bundleSkills: readonly string[]
}): Promise<ReingestEstimate> {
  const rootSteps = plannedIngestSkills(input.bundleSkills, "root").filter(
    (skill) => skill.run === "model",
  ).length
  const repositorySteps = plannedIngestSkills(
    input.bundleSkills,
    "repository",
  ).filter((skill) => skill.run === "model").length
  const history = await lastIngestionHistory(
    input.orgId,
    input.repositories.map((r) => r.url),
  )
  const perRepository = input.repositories.map((repository) => {
    const last = history.get(repository.url)
    const roots: EstimateRange = last
      ? { low: last.roots, high: last.roots }
      : { ...ESTIMATE.rootsWithoutHistory }
    const steps: EstimateRange = {
      low: roots.low * rootSteps + repositorySteps,
      high: roots.high * rootSteps + repositorySteps,
    }
    const costUsd = {
      low: steps.low * ESTIMATE.usdPerModelStep.low,
      high: steps.high * ESTIMATE.usdPerModelStep.high,
    }
    // The root steps of one shard run one after the other; shards run in
    // groups of `parallelShards`.
    const sequentialSteps = (count: number) => {
      const shards = Math.max(1, Math.ceil(count / INGEST_SHARD_MAX_ROOTS))
      return (
        Math.ceil(shards / ESTIMATE.parallelShards) *
          Math.min(count, INGEST_SHARD_MAX_ROOTS) *
          rootSteps +
        repositorySteps
      )
    }
    const minutes: EstimateRange = last
      ? { low: last.minutes, high: last.minutes * 1.5 }
      : {
          low:
            ESTIMATE.setupMinutes.low +
            sequentialSteps(roots.low) * ESTIMATE.minutesPerModelStep.low,
          high:
            ESTIMATE.setupMinutes.high +
            sequentialSteps(roots.high) * ESTIMATE.minutesPerModelStep.high,
        }
    return {
      repository: repository.repository,
      roots,
      costUsd,
      minutes,
      basis: last ? ("history" as const) : ("heuristic" as const),
    }
  })
  const sum = (pick: (r: (typeof perRepository)[number]) => EstimateRange) =>
    perRepository.reduce(
      (total, r) => ({
        low: total.low + pick(r).low,
        high: total.high + pick(r).high,
      }),
      { low: 0, high: 0 },
    )
  const costUsd = sum((r) => r.costUsd)
  const minutes = sum((r) => r.minutes)
  return {
    repositories: perRepository.length,
    costUsd: { low: round(costUsd.low, 2), high: round(costUsd.high, 2) },
    minutes: {
      low: Math.ceil(minutes.low),
      high: Math.ceil(minutes.high),
    },
    perRepository: perRepository.map((r) => ({
      ...r,
      costUsd: { low: round(r.costUsd.low, 2), high: round(r.costUsd.high, 2) },
      minutes: {
        low: Math.ceil(r.minutes.low),
        high: Math.ceil(r.minutes.high),
      },
    })),
  }
}

/**
 * The root count and the wall time of the last finished ingestion v2 run of
 * each source URL in the org. The root count comes from the `discover-roots`
 * step output (a gzip of the root list).
 */
async function lastIngestionHistory(
  orgId: string,
  urls: readonly string[],
): Promise<Map<string, { roots: number; minutes: number }>> {
  if (!urls.length) return new Map()
  const namespaceId = openWorkflowNamespaceId()
  const result = await withOrgDbContext(orgId, (db) =>
    db.execute<{
      url: string
      started_at: string | Date
      finished_at: string | Date
      roots: string | null
    }>(sql`
      select distinct on (run.input->'source'->>'url')
        run.input->'source'->>'url' as url, run.started_at, run.finished_at,
        discover.output->>'roots' as roots
      from openworkflow.workflow_runs run
      join openworkflow.step_attempts discover
        on discover.namespace_id = run.namespace_id
        and discover.workflow_run_id = run.id
        and discover.step_name = 'discover-roots'
        and discover.status = 'completed'
      where run.namespace_id = ${namespaceId}
        and run.workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and run.input->>'orgId' = ${orgId}
        and run.status in ('completed', 'succeeded')
        and run.started_at is not null and run.finished_at is not null
        and run.input->'source'->>'url' in (${sql.join(
          urls.map((url) => sql`${url}`),
          sql`, `,
        )})
      order by run.input->'source'->>'url', run.finished_at desc
    `),
  )
  const found = new Map<string, { roots: number; minutes: number }>()
  for (const row of result.rows) {
    if (!row.roots) continue
    let roots: number
    try {
      const list: unknown = JSON.parse(
        gunzipSync(Buffer.from(row.roots, "base64")).toString("utf8"),
      )
      if (!Array.isArray(list)) continue
      roots = list.length
    } catch {
      continue
    }
    const minutes =
      (new Date(row.finished_at).getTime() -
        new Date(row.started_at).getTime()) /
      60_000
    found.set(row.url, { roots, minutes: Math.max(1, minutes) })
  }
  return found
}

/** The idempotency key prefix of the ingestion v2 runs that a re-ingestion starts. */
const RUN_KEY_PREFIX = "upgrade-reingest:"

/** The idempotency key of one ingestion v2 run of a re-ingestion. */
export function reingestRunKey(input: {
  orgId: string
  workspaceId: string
  upgradeRunId: string
  repository: string
}): string {
  return `${RUN_KEY_PREFIX}${input.orgId}:${input.workspaceId}:${input.upgradeRunId}:${input.repository.toLowerCase()}`
}

/** The name of the upgrade workflow that holds a throttle slot. */
const REINGEST_WORKFLOW_NAME = "workspace-upgrade-reingest"

/**
 * Whether it is the turn of the upgrade run `upgradeRunId` (ADR-052). The
 * active upgrade runs keep their queue order (created first, then id): the
 * first run of each org is the head of that org, and the first
 * `runsPerInstance` heads run. A run holds its slot until it ends, so one
 * Workspace of an org runs at a time, and its repositories run one after the
 * other. The answer comes only from the run rows, so two runs cannot both
 * take the same slot, and a run that ended frees its slot.
 */
export async function reingestSlotTurn(input: {
  orgId: string
  upgradeRunId: string
  runsPerInstance: number
}): Promise<{ turn: true } | { wait: string }> {
  const result = await getSystemDb().execute<{
    org_head: string | null
    ahead: string
  }>(sql`
    with heads as (
      select distinct on (input->>'orgId') id, input->>'orgId' as org_id, created_at
      from openworkflow.workflow_runs
      where namespace_id = ${openWorkflowNamespaceId()}
        and workflow_name = ${REINGEST_WORKFLOW_NAME}
        and status in ('pending', 'running', 'sleeping')
      order by input->>'orgId', created_at, id
    )
    select
      (select id from heads where org_id = ${input.orgId}) as org_head,
      (select count(*) from heads h, heads me
        where me.id = ${input.upgradeRunId}
          and (h.created_at, h.id) < (me.created_at, me.id)) as ahead
  `)
  const row = result.rows[0]
  if (row?.org_head !== input.upgradeRunId)
    return {
      wait: "A re-ingestion of another Workspace of this organization runs.",
    }
  if (Number(row.ahead) >= input.runsPerInstance)
    return { wait: "The re-ingestion slots of this instance are full." }
  return { turn: true }
}

/** USD of one usage report: the gateway cost, else the tokens at the estimate prices. */
export function ingestUsageUsd(usage: IngestStepUsage): number {
  if (typeof usage.costUsd === "number") return usage.costUsd
  const price = ESTIMATE.usdPerMillionTokens
  return (
    (usage.inputTokens * price.input + usage.outputTokens * price.output) /
    1_000_000
  )
}

/** The ingestion v2 run `runId` and its child runs (the shards), as a `tree(id)` CTE. */
function ingestionRunTree(runId: string) {
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

/**
 * The model spend in USD of one ingestion v2 run so far: the usage that each
 * finished step of the run and of its child runs reports.
 */
export async function ingestionRunSpendUsd(runId: string): Promise<number> {
  const result = await getSystemDb().execute<{ usage: unknown }>(sql`
    ${ingestionRunTree(runId)}
    select attempt.output->'usage' as usage
    from openworkflow.step_attempts attempt
    join tree on tree.id = attempt.workflow_run_id
    where attempt.namespace_id = ${openWorkflowNamespaceId()}
      and attempt.status = 'completed'
      and jsonb_typeof(attempt.output->'usage') = 'object'
  `)
  let total = 0
  for (const { usage } of result.rows) {
    const value = usage as Partial<IngestStepUsage>
    total += ingestUsageUsd({
      inputTokens: Number(value.inputTokens) || 0,
      outputTokens: Number(value.outputTokens) || 0,
      ...(typeof value.costUsd === "number" ? { costUsd: value.costUsd } : {}),
    })
  }
  return total
}

/** The runs of an ingestion v2 run tree that have not ended, the run first. */
export async function activeIngestionRunTree(runId: string): Promise<string[]> {
  const result = await getSystemDb().execute<{ id: string }>(sql`
    ${ingestionRunTree(runId)}
    select run.id from openworkflow.workflow_runs run
    join tree on tree.id = run.id
    where run.namespace_id = ${openWorkflowNamespaceId()}
      and run.status in ('pending', 'running', 'sleeping')
    order by (run.id = ${runId}) desc, run.created_at
  `)
  return result.rows.map((row) => row.id)
}

/**
 * Why a re-ingestion cannot start on this Workspace now, or null. The scan
 * and the run use the same check. `format` is the Workspace format: the
 * caller handles a format that is newer than this code.
 */
export function reingestBlock(input: {
  format: number | null
  writeStatus: string
  readOnlyReason: string | null
  githubConnectionId: string | null
}): { blockedReason: UpgradeBlockedReason; note: string } | null {
  const sandbox = ingestSandboxUnavailable()
  if (
    input.format !== null &&
    input.format >= 0 &&
    input.format < REINGEST_REQUIRES_FORMAT
  )
    return {
      blockedReason: UPGRADE_BLOCKED_REASONS.needsFormat,
      note: `Re-ingestion needs format ${REINGEST_REQUIRES_FORMAT}. Merge the format upgrade first.`,
    }
  if (!ingestionV2EnabledFor({ formatVersion: input.format }))
    return {
      blockedReason: UPGRADE_BLOCKED_REASONS.ingestionV2Off,
      note: "Ingestion v2 does not publish to this Workspace yet: ctx| has not read a valid format file of it.",
    }
  if (sandbox)
    return {
      blockedReason: UPGRADE_BLOCKED_REASONS.sandboxUnavailable,
      note: sandbox,
    }
  if (input.writeStatus === "read_only" || !input.githubConnectionId)
    return {
      blockedReason: UPGRADE_BLOCKED_REASONS.writeAccess,
      note:
        input.readOnlyReason ??
        "Connect the Workspace repository with the GitHub App, so that ctx| can publish the re-ingestion.",
    }
  return null
}

/** The state of one ingestion v2 run. */
export async function ingestionRunState(runId: string): Promise<
  | { done: false }
  | {
      done: true
      status: "completed" | "failed" | "canceled"
      output: unknown
      error: string | null
    }
> {
  const result = await getSystemDb().execute<{
    status: string
    output: unknown
    error: { message?: string } | null
  }>(sql`
    select status, output, error from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()} and id = ${runId}
  `)
  const row = result.rows[0]
  if (!row)
    return {
      done: true,
      status: "failed",
      output: null,
      error: "The ingestion run is gone.",
    }
  if (["pending", "running", "sleeping"].includes(row.status))
    return { done: false }
  return {
    done: true,
    status:
      row.status === "completed" || row.status === "succeeded"
        ? "completed"
        : row.status === "canceled"
          ? "canceled"
          : "failed",
    output: row.output,
    error: row.error?.message ?? null,
  }
}
