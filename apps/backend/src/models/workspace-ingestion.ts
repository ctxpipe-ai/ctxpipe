import { and, eq, sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  unpackRoots,
} from "../domain/ingestion/ingestion-plan.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { repositorySourcePaths } from "../domain/workspace-sources/github-sources.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { getWorkspaceUpgradeRow } from "./workspace-upgrades.js"

export const INGESTION_STAGES = [
  "queued",
  "waiting",
  "planning",
  "indexing",
  "ingesting",
  "publishing",
  "syncing",
  "reingesting",
  "hydrating",
] as const

type IngestionStage = (typeof INGESTION_STAGES)[number]

/** One unit of ingestion work that runs now for a Workspace (CTX-959). */
type ActiveIngestionItem = {
  /** The workflow run. */
  id: string
  kind: "repository" | "source_sync" | "reingest" | "hydrate"
  /** `owner/name` of a repository, the provider of a sync, or the upgrade key. */
  name: string
  stage: IngestionStage
  progress: {
    done: number
    total: number
    unit: "shards" | "repositories"
  } | null
  /** When the run was queued. */
  startedAt: string
}

const SYNC_WORKFLOW_NAME = "workspace-sources-sync"
const REINGEST_WORKFLOW_NAME = "workspace-upgrade-reingest"
const HYDRATE_WORKFLOW_NAME = "workspace-hydrate"

/** The unzipped root list of a run is smaller than this. */
const MAX_ROOTS_BYTES = 32 * 1024 * 1024

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
 * with the Workspaces it writes to (CTX-959): ingestion v2 runs of a source
 * repository (not shadow runs), connector source syncs, upgrade
 * re-ingestions, and the hydrate of the newest commit of a Workspace when it
 * takes longer than 30 s. The read is polled. Each branch of the query is a
 * range scan of the index `(namespace_id, workflow_name, status, created_at)`
 * with a constant start time: a run older than one day (a hydrate: three
 * hours) does not count, because it is stuck. The limit of 200 applies after
 * the exclusions.
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
        connection_id, workspace_id, key
      from (
        select id, workflow_name, created_at,
          input#>>'{source,url}' as url,
          input->'destinations' as destinations,
          input->>'provider' as provider,
          input->>'connectionId' as connection_id,
          input->>'workspaceId' as workspace_id,
          input->>'key' as key
        from openworkflow.workflow_runs
        where namespace_id = ${namespaceId}
          and workflow_name in (${INGESTION_V2_WORKFLOW_NAME},
            ${SYNC_WORKFLOW_NAME}, ${REINGEST_WORKFLOW_NAME})
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
          workspace_id, null
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
  const syncs = runs.filter((run) => run.workflow_name === SYNC_WORKFLOW_NAME)

  // The source files of each Workspace name its repositories and
  // connections. Read them only when a run needs them.
  const sources =
    syncs.length ||
    runs.some(
      (run) =>
        run.workflow_name === INGESTION_V2_WORKFLOW_NAME &&
        !Array.isArray(run.destinations),
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
    let targets: string[]
    if (run.workflow_name === INGESTION_V2_WORKFLOW_NAME)
      targets = Array.isArray(run.destinations)
        ? run.destinations.map(String)
        : workspaceIds.filter((workspaceId) =>
            sourceUrls(workspaceId).has(
              normalizeWorkspaceRepositoryUrl(run.url ?? ""),
            ),
          )
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
 * `workspaceIds`, and if it hydrates the newest commit. This read does not
 * read the steps of the runs.
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
  for (const { run, workspaceIds: targets } of active)
    for (const workspaceId of targets) {
      const count = counts.get(workspaceId)
      if (!count) continue
      if (run.workflow_name === HYDRATE_WORKFLOW_NAME) count.hydrating = true
      else count.sources += 1
    }
  return counts
}

/**
 * For Workspace settings: the ingestion work that runs now for each
 * Workspace in `workspaceIds`, oldest first, with the stage and progress of
 * each run.
 */
export async function listActiveIngestion(
  orgId: string,
  workspaceIds: readonly string[],
): Promise<Map<string, ActiveIngestionItem[]>> {
  const byWorkspace = new Map<string, ActiveIngestionItem[]>(
    workspaceIds.map((id) => [id, []]),
  )
  if (!workspaceIds.length) return byWorkspace
  const namespaceId = openWorkflowNamespaceId()
  return withOrgDbContext(orgId, async () => {
    const db = getOrgDb()
    const active = await readActiveRuns(orgId, workspaceIds)
    const repositoryRuns = active.filter(
      ({ run, workspaceIds: targets }) =>
        run.workflow_name === INGESTION_V2_WORKFLOW_NAME && targets.length,
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

    for (const { run, workspaceIds: targets } of active) {
      if (!targets.length) continue
      const startedAt = new Date(run.created_at).toISOString()
      let item: ActiveIngestionItem
      if (run.workflow_name === INGESTION_V2_WORKFLOW_NAME) {
        item = {
          id: run.id,
          kind: "repository",
          name: repositoryName(run.url ?? ""),
          ...repositoryStage(steps.get(run.id)),
          startedAt,
        }
      } else if (run.workflow_name === SYNC_WORKFLOW_NAME) {
        const provider = run.provider ?? ""
        item = {
          id: run.id,
          kind: "source_sync",
          name: PROVIDER_NAMES[provider] ?? provider,
          stage: "syncing",
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
          stage: "reingesting",
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
          name: "Newest commit",
          stage: "hydrating",
          progress: null,
          startedAt,
        }
      }
      for (const workspaceId of targets)
        byWorkspace.get(workspaceId)?.push(item)
    }
    for (const items of byWorkspace.values())
      items.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    return byWorkspace
  })
}

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  confluence: "Confluence",
  linear: "Linear",
  notion: "Notion",
  slack: "Slack",
  pagerduty: "PagerDuty",
  git: "Git",
}

/** `owner/name` of a repository URL. */
function repositoryName(url: string): string {
  try {
    return (
      new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "") ||
      url
    )
  } catch {
    return url
  }
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
      unpackRoots(step.roots, MAX_ROOTS_BYTES).length / INGEST_SHARD_MAX_ROOTS,
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
