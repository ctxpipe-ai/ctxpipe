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

/** A hydrate shows only after this time: most hydrates take seconds. */
const SLOW_HYDRATE_SECONDS = 30

const SYNC_WORKFLOW_NAME = "workspace-sources-sync"
const REINGEST_WORKFLOW_NAME = "workspace-upgrade-reingest"
const HYDRATE_WORKFLOW_NAME = "workspace-hydrate"

type RunRow = {
  id: string
  workflow_name: string
  input: Record<string, unknown> | null
  created_at: string | Date
  age_seconds: number | string
}

type StepRow = {
  id: string
  last_step: string | null
  waiting: boolean | null
  shards_done: number | string | null
  roots: string | null
}

/**
 * The ingestion work that runs now for each Workspace in `workspaceIds`, read
 * from the workflow runs (CTX-959): ingestion v2 runs of a source repository,
 * connector source syncs, upgrade re-ingestions, and a hydrate of the newest
 * commit when it takes longer than 30 s. The read is polled, so each query
 * uses an index of the run tables and has a bound. A run older than one day
 * (a hydrate: three hours) does not count, because it is stuck.
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
    const runs = (
      await db.execute<RunRow>(sql`
        select id, workflow_name, input, created_at,
          extract(epoch from now() - created_at) as age_seconds
        from openworkflow.workflow_runs
        where namespace_id = ${namespaceId}
          and workflow_name in (${INGESTION_V2_WORKFLOW_NAME}, ${SYNC_WORKFLOW_NAME},
            ${REINGEST_WORKFLOW_NAME}, ${HYDRATE_WORKFLOW_NAME})
          and status in ('pending', 'running', 'sleeping')
          and input->>'orgId' = ${orgId}
          and created_at > now() - case workflow_name
            when ${HYDRATE_WORKFLOW_NAME} then interval '3 hours'
            else interval '1 day' end
        order by created_at desc, id desc
        limit 200
      `)
    ).rows
    const repositoryRuns = runs.filter(
      (run) =>
        run.workflow_name === INGESTION_V2_WORKFLOW_NAME &&
        run.input?.shadow !== true,
    )
    const syncRuns = runs.filter(
      (run) =>
        run.workflow_name === SYNC_WORKFLOW_NAME &&
        run.input?.kind === "connection",
    )

    // The source files of each Workspace name its repositories and
    // connections. Read them only when a run needs them.
    const sources =
      syncRuns.length ||
      repositoryRuns.some((run) => !Array.isArray(run.input?.destinations))
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

    const steps = new Map<string, StepRow>()
    if (repositoryRuns.length) {
      const ids = sql.join(
        repositoryRuns.map((run) => sql`${run.id}`),
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

    const hydrateSeen = new Set<string>()
    const add = (workspaceId: string, item: ActiveIngestionItem) =>
      byWorkspace.get(workspaceId)?.push(item)

    for (const run of runs) {
      const startedAt = new Date(run.created_at).toISOString()
      const input = run.input ?? {}
      if (run.workflow_name === INGESTION_V2_WORKFLOW_NAME) {
        if (input.shadow === true) continue
        const url = String(
          (input.source as { url?: unknown } | undefined)?.url ?? "",
        )
        const destinations = Array.isArray(input.destinations)
          ? input.destinations.map(String)
          : workspaceIds.filter((workspaceId) =>
              sourceUrls(workspaceId).has(normalizeWorkspaceRepositoryUrl(url)),
            )
        const step = steps.get(run.id)
        const item: ActiveIngestionItem = {
          id: run.id,
          kind: "repository",
          name: repositoryName(url),
          ...repositoryStage(step),
          startedAt,
        }
        for (const workspaceId of destinations) add(workspaceId, item)
      } else if (run.workflow_name === SYNC_WORKFLOW_NAME) {
        if (input.kind !== "connection") continue
        const provider = String(input.provider ?? "")
        const connected = new Set(
          sources
            .filter((row) => row.connectionId === input.connectionId)
            .map((row) => row.workspaceId),
        )
        for (const workspaceId of connected)
          add(workspaceId, {
            id: run.id,
            kind: "source_sync",
            name: PROVIDER_NAMES[provider] ?? provider,
            stage: "syncing",
            progress: null,
            startedAt,
          })
      } else if (run.workflow_name === REINGEST_WORKFLOW_NAME) {
        const workspaceId = String(input.workspaceId ?? "")
        if (!byWorkspace.has(workspaceId)) continue
        const key = String(input.key ?? "")
        const row = await getWorkspaceUpgradeRow(workspaceId, key)
        const repositories = row?.upgrade.repositories ?? []
        add(workspaceId, {
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
        })
      } else if (run.workflow_name === HYDRATE_WORKFLOW_NAME) {
        const workspaceId = String(input.workspaceId ?? "")
        // The runs come newest first: only the newest commit counts, and a
        // newer hydrate that is still fast hides an older slow one.
        if (hydrateSeen.has(workspaceId)) continue
        hydrateSeen.add(workspaceId)
        if (Number(run.age_seconds) > SLOW_HYDRATE_SECONDS)
          add(workspaceId, {
            id: run.id,
            kind: "hydrate",
            name: "Newest commit",
            stage: "hydrating",
            progress: null,
            startedAt,
          })
      }
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
  const total = Math.ceil(
    unpackRoots(step.roots).length / INGEST_SHARD_MAX_ROOTS,
  )
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
