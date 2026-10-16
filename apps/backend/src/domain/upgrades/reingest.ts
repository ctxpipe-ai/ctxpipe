import { gunzipSync } from "node:zlib"
import { and, eq, sql } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  plannedIngestSkills,
} from "../ingestion/ingestion-plan.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { lockedSandboxProvider } from "../workspaces/sandbox-provider.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import type { EstimateRange, ReingestEstimate } from "./registry.js"

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
 * The throttle of re-ingestion runs. This is committed config, not an env
 * var. One Workspace of an org runs at a time, and it runs one source
 * repository at a time, so an org runs at most one repository. This is in
 * the ADR-053 limit of 2 repositories for each org, and in the ADR-052 limit
 * of 40 ingest sandboxes for each org.
 */
export const REINGEST_THROTTLE = {
  /** Re-ingestion runs (one source repository each) on this instance at a time. */
  runsPerInstance: 4,
  /** How long a run waits before it looks for a free slot again. */
  slotPoll: "1 minute" as "1 second" | "1 minute",
  /** How long a run waits before it reads the state of its ingestion run again. */
  runPoll: "1 minute" as "1 second" | "1 minute",
  /** The polls of one ingestion run before the upgrade stops with a failure (24 hours). */
  maxRunPolls: 1440,
} as const

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

/**
 * Take a slot for one ingestion v2 run, and start the run with `start` while
 * the slot lock is held. The slot is free when (1) no ingestion v2 run of a
 * re-ingestion of another Workspace of the org is active, (2) no other run of
 * this Workspace is active, and (3) fewer than
 * {@link REINGEST_THROTTLE.runsPerInstance} such runs are active on the
 * instance. One advisory lock makes the check and the start one action, so
 * two Workspaces cannot both take the last slot. The OpenWorkflow insert
 * commits on its own connection before the lock goes. A run that started
 * before (the same key) is returned again, also when no slot is free.
 */
export async function takeReingestSlot(input: {
  orgId: string
  workspaceId: string
  key: string
  start: () => Promise<string>
  runsPerInstance?: number
}): Promise<{ runId: string } | { wait: string }> {
  const namespaceId = openWorkflowNamespaceId()
  const orgPrefix = `${RUN_KEY_PREFIX}${input.orgId}:`
  return getSystemDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('workspace-upgrade-reingest-slots', 0))`,
    )
    const result = await tx.execute<{
      same: boolean
      org_other: string
      org_same: string
      instance: string
    }>(sql`
      select
        coalesce(bool_or(idempotency_key = ${input.key}), false) as same,
        count(*) filter (where idempotency_key like ${`${orgPrefix}%`}
          and idempotency_key not like ${`${orgPrefix}${input.workspaceId}:%`}) as org_other,
        count(*) filter (where idempotency_key like ${`${orgPrefix}${input.workspaceId}:%`}) as org_same,
        count(*) as instance
      from openworkflow.workflow_runs
      where namespace_id = ${namespaceId}
        and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and status in ('pending', 'running', 'sleeping')
        and idempotency_key like ${`${RUN_KEY_PREFIX}%`}
    `)
    const counts = result.rows[0]
    if (!counts?.same) {
      if (Number(counts?.org_other ?? 0) > 0)
        return {
          wait: "A re-ingestion of another Workspace of this organization runs.",
        }
      if (Number(counts?.org_same ?? 0) > 0)
        return { wait: "Another repository of this Workspace runs." }
      if (
        Number(counts?.instance ?? 0) >=
        (input.runsPerInstance ?? REINGEST_THROTTLE.runsPerInstance)
      )
        return { wait: "The re-ingestion slots of this instance are full." }
    }
    return { runId: await input.start() }
  })
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
