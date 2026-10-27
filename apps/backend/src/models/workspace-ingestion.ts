import { and, eq, inArray, sql } from "drizzle-orm"

import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  unpackRoots,
} from "../domain/ingestion/ingestion-plan.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { reingestRunKeyPrefix } from "../domain/upgrades/reingest.js"
import { repositorySourcePaths } from "../domain/workspace-sources/github-sources.js"
import { SOURCE_SCOPES } from "../domain/workspace-sources/sources-file.js"
import {
  normalizeWorkspaceRepositoryUrl,
  repositoryNameFromGitUrl,
} from "../domain/workspaces/slug.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { getWorkspaceUpgradeRow } from "./workspace-upgrades.js"

/** The stages of a repository run. The other kinds of work have no stage. */
export const INGESTION_STAGES = [
  "queued",
  "waiting",
  "planning",
  "indexing",
  "ingesting",
  "publishing",
] as const

type IngestionStage = (typeof INGESTION_STAGES)[number]

/** One unit of ingestion work that runs now for a Workspace (CTX-959). */
type ActiveIngestionItem = {
  /** The workflow run. */
  id: string
  kind: "repository" | "source_sync" | "reingest" | "hydrate"
  /**
   * `owner/name` of a repository, the provider of a sync, or the upgrade key.
   * Null for a hydrate.
   */
  name: string | null
  /** Null when the work is not a repository run. */
  stage: IngestionStage | null
  progress: {
    done: number
    total: number
    unit: "shards" | "repositories"
  } | null
  /** When the run was queued. */
  startedAt: string
}

const INDEX_WORKFLOW_NAME = "repository-ingestion"
const SYNC_WORKFLOW_NAME = "workspace-sources-sync"
const REINGEST_WORKFLOW_NAME = "workspace-upgrade-reingest"
const HYDRATE_WORKFLOW_NAME = "workspace-hydrate"

/** A run and the input keys that the read uses. */
type RunRow = {
  id: string
  workflow_name: string
  created_at: string | Date
  url: string | null
  destinations: unknown
  provider: string | null
  connection_id: string | null
  workspace_id: string | null
  key: string | null
  repository_id: string | null
  idempotency_key: string | null
  /** The output of the `resolve` step of an ingestion v2 run, when it is done. */
  resolved: {
    skipped?: string
    destinations?: { workspaceId: string }[]
  } | null
}

type StepRow = {
  id: string
  last_step: string | null
  waiting: boolean | null
  shards_done: number | string | null
  roots: string | null
}

type ActiveRun = { run: RunRow; workspaceIds: string[] }

/**
 * The ingestion runs that run now for the Workspaces in `workspaceIds`, each
 * with the Workspaces it writes to (CTX-959): the code index of a repository
 * (`repository-ingestion`, which runs before ingestion v2), ingestion v2 runs
 * of a source repository (not shadow runs), connector source syncs, upgrade
 * re-ingestions, and the hydrate of the newest commit of a Workspace when it
 * takes longer than 30 s. The read is polled. Each branch of the query is a
 * range scan of the index `(namespace_id, workflow_name, status, created_at)`
 * with a constant start time: a run older than one day (a hydrate: three
 * hours) does not count, because it is stuck. The limit of 200 applies after
 * the exclusions. An ingestion v2 run reads only its `resolve` step: after
 * that step its destinations come from the step output, which applies the
 * format, write, and provider checks of the run.
 */
async function readActiveRuns(
  orgId: string,
  workspaceIds: readonly string[],
): Promise<ActiveRun[]> {
  const namespaceId = openWorkflowNamespaceId()
  const db = getOrgDb()
  const runs = (
    await db.execute<RunRow>(sql`
      select id, workflow_name, created_at, url, destinations, provider,
        connection_id, workspace_id, key, repository_id, idempotency_key,
        case when workflow_name = ${INGESTION_V2_WORKFLOW_NAME} then (
          select s.output from openworkflow.step_attempts s
          where s.namespace_id = ${namespaceId} and s.workflow_run_id = runs.id
            and s.step_name = 'resolve' and s.status = 'completed'
          limit 1
        ) end as resolved
      from (
        select id, workflow_name, created_at,
          input#>>'{source,url}' as url,
          input->'destinations' as destinations,
          input->>'provider' as provider,
          input->>'connectionId' as connection_id,
          input->>'workspaceId' as workspace_id,
          input->>'key' as key,
          input->>'repositoryId' as repository_id,
          idempotency_key
        from openworkflow.workflow_runs
        where namespace_id = ${namespaceId}
          and workflow_name in (${INDEX_WORKFLOW_NAME},
            ${INGESTION_V2_WORKFLOW_NAME}, ${SYNC_WORKFLOW_NAME},
            ${REINGEST_WORKFLOW_NAME})
          and status in ('pending', 'running', 'sleeping')
          and created_at > now() - interval '1 day'
          and input->>'orgId' = ${orgId}
          and (workflow_name <> ${INGESTION_V2_WORKFLOW_NAME}
            or (input->'shadow') is distinct from 'true'::jsonb)
          and (workflow_name <> ${SYNC_WORKFLOW_NAME}
            or input->>'kind' = 'connection')
        union all
        -- Only the newest hydrate of a Workspace counts, and only when it
        -- takes longer than 30 s: a newer fast hydrate hides an older slow
        -- one.
        select id, workflow_name, created_at, null, null, null, null,
          workspace_id, null, null, null
        from (
          select distinct on (input->>'workspaceId') id, workflow_name,
            created_at, input->>'workspaceId' as workspace_id
          from openworkflow.workflow_runs
          where namespace_id = ${namespaceId}
            and workflow_name = ${HYDRATE_WORKFLOW_NAME}
            and status in ('pending', 'running', 'sleeping')
            and created_at > now() - interval '3 hours'
            and input->>'orgId' = ${orgId}
          order by input->>'workspaceId', created_at desc, id desc
        ) newest
        where created_at < now() - interval '30 seconds'
      ) runs
      order by created_at desc, id desc
      limit 200
    `)
  ).rows
  const indexRepositoryIds = runs.flatMap((run) =>
    run.workflow_name === INDEX_WORKFLOW_NAME && run.repository_id
      ? [run.repository_id]
      : [],
  )
  const gitUrls = new Map(
    indexRepositoryIds.length
      ? (
          await db
            .select({ id: repositories.id, gitUrl: repositories.gitUrl })
            .from(repositories)
            .where(
              and(
                eq(repositories.orgId, orgId),
                inArray(repositories.id, indexRepositoryIds),
              ),
            )
        ).map((row) => [row.id, row.gitUrl])
      : [],
  )
  for (const run of runs)
    if (run.workflow_name === INDEX_WORKFLOW_NAME)
      run.url = gitUrls.get(run.repository_id ?? "") ?? null

  // The source files of each Workspace name its repositories and
  // connections. Read them only when a run needs them.
  const sources = runs.some(
    (run) =>
      run.workflow_name === SYNC_WORKFLOW_NAME ||
      (run.workflow_name === INDEX_WORKFLOW_NAME && run.url) ||
      (run.workflow_name === INGESTION_V2_WORKFLOW_NAME &&
        !run.resolved &&
        !Array.isArray(run.destinations)),
  )
    ? await db
        .select({
          workspaceId: workspaceSources.workspaceId,
          sourceKey: workspaceSources.sourceKey,
          provider: workspaceSources.provider,
          connectionId: workspaceSources.connectionId,
          status: workspaceSources.status,
          scope: workspaceSources.scope,
        })
        .from(workspaceSources)
        .where(
          and(
            eq(workspaceSources.orgId, orgId),
            eq(workspaceSources.status, "ok"),
          ),
        )
    : []

  const urls = new Map<string, Set<string>>()
  const sourceUrls = (workspaceId: string) => {
    let found = urls.get(workspaceId)
    if (!found) {
      found = new Set(
        repositorySourcePaths(
          sources.filter((row) => row.workspaceId === workspaceId),
        ).keys(),
      )
      urls.set(workspaceId, found)
    }
    return found
  }

  const known = new Set(workspaceIds)
  return runs.map((run) => {
    const declaring = () =>
      run.url
        ? workspaceIds.filter((workspaceId) =>
            sourceUrls(workspaceId).has(
              normalizeWorkspaceRepositoryUrl(run.url ?? ""),
            ),
          )
        : []
    let targets: string[]
    if (run.workflow_name === INDEX_WORKFLOW_NAME) targets = declaring()
    else if (run.workflow_name === INGESTION_V2_WORKFLOW_NAME)
      targets = run.resolved
        ? run.resolved.skipped
          ? []
          : (run.resolved.destinations ?? []).map((d) => d.workspaceId)
        : Array.isArray(run.destinations)
          ? run.destinations.map(String)
          : declaring()
    else if (run.workflow_name === SYNC_WORKFLOW_NAME)
      targets = [
        ...new Set(
          sources
            .filter((row) => row.connectionId === run.connection_id)
            .map((row) => row.workspaceId),
        ),
      ]
    else targets = [run.workspace_id ?? ""]
    return {
      run,
      workspaceIds: targets.filter((workspaceId) => known.has(workspaceId)),
    }
  })
}

/**
 * For the sidebar: the count of source runs of each Workspace in
 * `workspaceIds`, and if it hydrates the newest commit. An upgrade
 * re-ingestion that has an active ingestion v2 run does not count again: that
 * run counts.
 */
export async function countActiveIngestion(
  orgId: string,
  workspaceIds: readonly string[],
): Promise<Map<string, { sources: number; hydrating: boolean }>> {
  const counts = new Map(
    workspaceIds.map((id) => [id, { sources: 0, hydrating: false }]),
  )
  if (!workspaceIds.length) return counts
  const active = await withOrgDbContext(orgId, () =>
    readActiveRuns(orgId, workspaceIds),
  )
  const keys = active.flatMap(({ run }) =>
    run.workflow_name === INGESTION_V2_WORKFLOW_NAME && run.idempotency_key
      ? [run.idempotency_key]
      : [],
  )
  for (const { run, workspaceIds: targets } of active) {
    if (run.workflow_name === REINGEST_WORKFLOW_NAME) {
      const prefix = reingestRunKeyPrefix({
        orgId,
        workspaceId: run.workspace_id ?? "",
        upgradeRunId: run.id,
      })
      if (keys.some((key) => key.startsWith(prefix))) continue
    }
    for (const workspaceId of targets) {
      const count = counts.get(workspaceId)
      if (!count) continue
      if (run.workflow_name === HYDRATE_WORKFLOW_NAME) count.hydrating = true
      else count.sources += 1
    }
  }
  return counts
}

/**
 * For Workspace settings: the ingestion work that runs now for the
 * Workspace, oldest first, with the stage and progress of each run.
 */
export async function listActiveIngestion(
  orgId: string,
  workspaceId: string,
): Promise<ActiveIngestionItem[]> {
  const namespaceId = openWorkflowNamespaceId()
  return withOrgDbContext(orgId, async () => {
    const db = getOrgDb()
    const active = (await readActiveRuns(orgId, [workspaceId])).filter(
      ({ workspaceIds: targets }) => targets.length,
    )
    const repositoryRuns = active.filter(
      ({ run }) => run.workflow_name === INGESTION_V2_WORKFLOW_NAME,
    )

    const steps = new Map<string, StepRow>()
    if (repositoryRuns.length) {
      const ids = sql.join(
        repositoryRuns.map(({ run }) => sql`${run.id}`),
        sql`, `,
      )
      const rows = await db.execute<StepRow>(sql`
        select r.id, last.step_name as last_step, last.waiting,
          (select count(distinct s.step_name) from openworkflow.step_attempts s
            where s.namespace_id = ${namespaceId} and s.workflow_run_id = r.id
              and s.step_name like 'shard:%' and s.status = 'completed'
          ) as shards_done,
          (select s.output->>'roots' from openworkflow.step_attempts s
            where s.namespace_id = ${namespaceId} and s.workflow_run_id = r.id
              and s.step_name = 'discover-roots' and s.status = 'completed'
            limit 1
          ) as roots
        from unnest(array[${ids}]::text[]) as r(id)
        left join lateral (
          select s.step_name, s.output->>'wait' is not null as waiting
          from openworkflow.step_attempts s
          where s.namespace_id = ${namespaceId} and s.workflow_run_id = r.id
          order by s.created_at desc, s.id desc
          limit 1
        ) last on true
      `)
      for (const row of rows.rows) steps.set(row.id, row)
    }

    const items: ActiveIngestionItem[] = []
    for (const { run } of active) {
      const startedAt = new Date(run.created_at).toISOString()
      let item: ActiveIngestionItem
      if (run.workflow_name === INDEX_WORKFLOW_NAME) {
        item = {
          id: run.id,
          kind: "repository",
          name: repositoryNameFromGitUrl(run.url ?? ""),
          stage: "indexing",
          progress: null,
          startedAt,
        }
      } else if (run.workflow_name === INGESTION_V2_WORKFLOW_NAME) {
        item = {
          id: run.id,
          kind: "repository",
          name: repositoryNameFromGitUrl(run.url ?? ""),
          ...repositoryStage(steps.get(run.id)),
          startedAt,
        }
      } else if (run.workflow_name === SYNC_WORKFLOW_NAME) {
        const provider = run.provider ?? ""
        item = {
          id: run.id,
          kind: "source_sync",
          name:
            SOURCE_SCOPES[provider as keyof typeof SOURCE_SCOPES]?.label ??
            provider,
          stage: null,
          progress: null,
          startedAt,
        }
      } else if (run.workflow_name === REINGEST_WORKFLOW_NAME) {
        const key = run.key ?? ""
        const row = await getWorkspaceUpgradeRow(run.workspace_id ?? "", key)
        const repositories = row?.upgrade.repositories ?? []
        item = {
          id: run.id,
          kind: "reingest",
          name: key,
          stage: null,
          progress: repositories.length
            ? {
                done: repositories.filter((r) => r.status !== "pending").length,
                total: repositories.length,
                unit: "repositories",
              }
            : null,
          startedAt,
        }
      } else {
        item = {
          id: run.id,
          kind: "hydrate",
          name: null,
          stage: null,
          progress: null,
          startedAt,
        }
      }
      items.push(item)
    }
    return items.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  })
}

/**
 * The stage of an ingestion v2 run from its newest step, and the count of
 * done shards while the shards run. The step names come from
 * `repository-ingestion-v2.ts`; a step that this list does not know is
 * planning before `discover-roots` and ingesting after it.
 */
function repositoryStage(
  step: StepRow | undefined,
): Pick<ActiveIngestionItem, "stage" | "progress"> {
  const last = step?.last_step
  if (!step || !last) return { stage: "queued", progress: null }
  // A run waits for an earlier run of the same source (CTX-895, CTX-964).
  if (
    last.startsWith("wait-publish-turn:") ||
    (last.startsWith("publish-turn:") && step.waiting)
  )
    return { stage: "waiting", progress: null }
  if (last === "index") return { stage: "indexing", progress: null }
  if (/^(publish-target|publish|delete-refs):/.test(last))
    return { stage: "publishing", progress: null }
  if (!step.roots) return { stage: "planning", progress: null }
  let total: number
  try {
    total = Math.ceil(
      // The unzipped root list of a run is smaller than 32 MB.
      unpackRoots(step.roots, 32 * 1024 * 1024).length / INGEST_SHARD_MAX_ROOTS,
    )
  } catch {
    // A corrupt or too large root list hides only the progress of this run.
    return { stage: "ingesting", progress: null }
  }
  return {
    stage: "ingesting",
    progress: total
      ? {
          done: Math.min(Number(step.shards_done ?? 0), total),
          total,
          unit: "shards",
        }
      : null,
  }
}
