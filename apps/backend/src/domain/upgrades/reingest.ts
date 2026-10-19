import { gunzipSync } from "node:zlib"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { ingestionRunTree } from "../ingestion/ingest-cost-cap.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  plannedIngestSkills,
} from "../ingestion/ingestion-plan.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  type IngestSource,
} from "../ingestion/ingestion-run.js"
import { ingestionV2EnabledFor } from "../ingestion/ingestion-v2-config.js"
import {
  gitSourceScopeUrl,
  sourceRepositoryName,
} from "../workspace-sources/providers/git.js"
import { githubSourceScopeRepositories } from "../workspace-sources/providers/github.js"
import { hostedIngestEgressEnabled } from "../workspaces/ingest-sandbox-egress.js"
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
 * runs ingestion v2 again for each source repository of a Workspace: each
 * GitHub source repository, and each plain git source repository (CTX-815).
 * An owner or admin starts it after the UI shows the estimate. Nothing
 * starts it automatically.
 */

/** The re-ingestion needs this format or higher (G5). */
export const REINGEST_REQUIRES_FORMAT = 3

/**
 * The throttle of re-ingestion (ADR-052): one upgrade run of an org at a
 * time, with its repositories one after the other, and a cap of upgrade runs
 * on the instance. The polls of a repository run back off from `firstPoll`,
 * so a long run spends few workflow steps. The slot polls stay short
 * (CTX-898): no event wakes a waiting run when a slot frees, so a long poll
 * left the slot idle for up to that poll.
 */
export const REINGEST_THROTTLE = {
  /** Upgrade runs (each one org) that run their repositories at a time on this instance. */
  runsPerInstance: 4,
  firstPollSeconds: 60,
  /** The longest wait of the upgrade run between two checks of its turn. */
  maxSlotPollSeconds: 60,
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
} as const

export { ingestionRunSpend } from "../ingestion/ingest-cost-cap.js"
export { isReingestUpgradeKey, reingestUpgradeKey } from "./keys.js"

/**
 * Why this deployment cannot run an ingest sandbox, or null. It makes the
 * same provider choice as ingestion (`ingestIsolation` in
 * `ingest-shard-sandbox.ts`): Vercel on hosted, Docker on self-host. A Docker
 * host that does not answer fails the run with its own message
 * (`dockerHostError`), because only a start of a container proves it.
 */
export function ingestSandboxUnavailable(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const provider = lockedSandboxProvider(env) ?? "docker"
  if (provider === "docker") return null
  if (provider === "vercel")
    return hostedIngestEgressEnabled(env)
      ? null
      : "Re-ingestion needs the Vercel sandbox settings. Set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID on the backend and the worker."
  return "Re-ingestion needs a Docker or Vercel sandbox. This deployment runs agents unsandboxed."
}

export type ReingestRepository = {
  /** `owner/name` for GitHub; `<host>/<path>` for plain git (`sourceRepositoryName`). */
  repository: string
  url: string
  /** Null for a plain git repository, which ctx| reads with no credential. */
  githubConnectionId: string | null
}

/** The ingestion source of a re-ingestion repository. */
export function reingestSource(repository: {
  url: string
  githubConnectionId: string | null
}): IngestSource {
  return repository.githubConnectionId
    ? {
        kind: "github",
        url: repository.url,
        githubConnectionId: repository.githubConnectionId,
      }
    : { kind: "git", url: repository.url }
}

/**
 * The source repositories of a Workspace: each repository of a valid GitHub
 * source and each URL of a valid plain git source (`status` ok), once,
 * sorted. Call it outside an org transaction.
 */
export async function workspaceSourceRepositories(
  orgId: string,
  workspaceId: string,
): Promise<ReingestRepository[]> {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        provider: workspaceSources.provider,
        connectionId: workspaceSources.connectionId,
        scope: workspaceSources.scope,
      })
      .from(workspaceSources)
      .where(
        and(
          eq(workspaceSources.workspaceId, workspaceId),
          inArray(workspaceSources.provider, ["github", "git"]),
          eq(workspaceSources.status, "ok"),
        ),
      ),
  )
  const found = new Map<string, ReingestRepository>()
  for (const row of rows) {
    if (row.provider === "git") {
      const url = gitSourceScopeUrl(row.scope)
      const repository = url ? sourceRepositoryName(url) : null
      if (!url || !repository || found.has(repository.toLowerCase())) continue
      found.set(repository.toLowerCase(), {
        repository,
        url,
        githubConnectionId: null,
      })
      continue
    }
    if (!row.connectionId) continue
    // A source file (`sources/github/...`, format 2 and up) has one
    // `repository`; a `.ctxpipe/sources.yaml` entry has `repositories`.
    for (const { name } of githubSourceScopeRepositories(row.scope)) {
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
  return `${reingestRunKeyPrefix(input)}${input.repository.toLowerCase()}`
}

/** The idempotency key prefix of the ingestion v2 runs of one upgrade run. */
export function reingestRunKeyPrefix(input: {
  orgId: string
  workspaceId: string
  upgradeRunId: string
}): string {
  return `${RUN_KEY_PREFIX}${input.orgId}:${input.workspaceId}:${input.upgradeRunId}:`
}

/** The name of the upgrade workflow that holds a throttle slot. */
const REINGEST_WORKFLOW_NAME = "workspace-upgrade-reingest"

/** The name of the child workflow that runs one repository of a re-ingestion. */
export const REINGEST_REPOSITORY_WORKFLOW_NAME =
  "workspace-upgrade-reingest-repository"

/**
 * Whether it is the turn of the upgrade run `upgradeRunId` (ADR-052). The
 * active upgrade runs keep their queue order (created first, then id): the
 * first run of each org is the head of that org, and the first
 * `runsPerInstance` heads run. A run holds its slot until it ends, so one
 * Workspace of an org runs at a time, and its repositories run one after the
 * other. Two runs that start in the same millisecond keep the id order, so
 * the same run gets the slot at each ask. A repository run of an earlier
 * upgrade run of the org that is still active also holds the slot, so a run
 * that ended early frees no slot while its children spend. The answer comes only from the run
 * rows, so two runs cannot both take the same slot, and a run that ended
 * frees its slot.
 *
 * An ingestion v2 run of a source repository in `sourceUrls` that can publish
 * to the Workspace (CTX-895) also makes the run wait. Both runs pin the same
 * revision, so the later publish finds each file of the run changed on the
 * default branch, and only the merge model can join them. When the upgrade
 * waits, its run pins the revision that the other run published.
 */
export async function reingestSlotTurn(input: {
  orgId: string
  upgradeRunId: string
  runsPerInstance: number
  workspaceId: string
  sourceUrls: readonly string[]
}): Promise<{ turn: true } | { wait: string }> {
  const sourceUrls = input.sourceUrls.map((url) => url.toLowerCase())
  const result = await getSystemDb().execute<{
    org_head: string | null
    ahead: string
    open_children: string
    open_ingestions: string
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
          and (h.created_at, h.id) < (me.created_at, me.id)) as ahead,
      (select count(*) from openworkflow.workflow_runs child
        where child.namespace_id = ${openWorkflowNamespaceId()}
          and child.workflow_name = ${REINGEST_REPOSITORY_WORKFLOW_NAME}
          and child.status in ('pending', 'running', 'sleeping')
          and child.input->>'orgId' = ${input.orgId}
          and child.input->>'upgradeRunId' <> ${input.upgradeRunId}) as open_children,
      (select count(*) from openworkflow.workflow_runs ingest
        where ingest.namespace_id = ${openWorkflowNamespaceId()}
          and ingest.workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
          and ingest.status in ('pending', 'running', 'sleeping')
          and ingest.input->>'orgId' = ${input.orgId}
          and ingest.input->>'shadow' = 'false'
          and ${
            sourceUrls.length
              ? sql`lower(ingest.input->'source'->>'url') in (${sql.join(
                  sourceUrls.map((url) => sql`${url}`),
                  sql`, `,
                )})`
              : sql`false`
          }
          and (ingest.input->'destinations' is null
            or ingest.input->'destinations' @> ${JSON.stringify([input.workspaceId])}::jsonb)) as open_ingestions
  `)
  const row = result.rows[0]
  if (row?.org_head !== input.upgradeRunId)
    return {
      wait: "A re-ingestion of another Workspace of this organization runs.",
    }
  // A repository run of an upgrade run that ended (failed or canceled) can
  // still spend. Its slot stays taken until that run ends too.
  if (Number(row.open_children) > 0)
    return {
      wait: "A repository run of an earlier re-ingestion of this organization has not ended.",
    }
  if (Number(row.ahead) >= input.runsPerInstance)
    return { wait: "The re-ingestion slots of this instance are full." }
  if (Number(row.open_ingestions) > 0)
    return {
      wait: "An ingestion run of a source repository of this Workspace has not ended. The re-ingestion starts after it.",
    }
  return { turn: true }
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
      note:
        input.writeStatus === "read_only" || !input.githubConnectionId
          ? `Re-ingestion needs format ${REINGEST_REQUIRES_FORMAT}. ctx| needs write access through the GitHub App to open the format upgrade pull request.`
          : `Re-ingestion needs format ${REINGEST_REQUIRES_FORMAT}. Merge the format upgrade first.`,
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
