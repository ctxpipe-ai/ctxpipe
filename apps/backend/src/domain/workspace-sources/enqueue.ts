import { createHash } from "node:crypto"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { assertNotInOrgDbContext, getSystemDb } from "../../db/client.js"
import {
  lastGoodTarget,
  type SourceTarget,
} from "../../models/workspace-source-state.js"
import {
  listConnectionSourceRows,
  listConnectionsWithOkSources,
  sameSource,
  type WorkspaceSourceRow,
} from "../../models/workspace-sources.js"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { workspaceSourcesSync } from "../../openworkflow/workflows/workspace-sources-sync.js"
import type { IngestionPublishPipeline } from "../ingestion/ingestion-v2-config.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { SOURCE_ADAPTERS } from "./adapter.js"
import { handOverLegacyBindings } from "./legacy-handover.js"
import type { PlannedSourceRow } from "./projection-plan.js"
import { githubSourceScopeRepositories } from "./providers/github.js"
import { type SourceProvider, sourceProviderSchema } from "./sources-file.js"

/**
 * Sync one connection for all its `ok` sources. A provider webhook passes its
 * `event`, and then only the sources that match the event sync.
 */
export async function enqueueConnectionSourcesSync(input: {
  orgId: string
  connectionId: string
  provider: SourceProvider
  event?: unknown
  /** A "Sync now" sync: its failures do not count toward the bounded tries. */
  manual?: true
  /**
   * A key for one provider change. A second enqueue with the same key (a
   * repeated webhook delivery) starts no new run.
   */
  dedupeKey?: string
  /** The earliest start of the sync. Default: now. */
  availableAt?: Date
}): Promise<void> {
  assertNotInOrgDbContext()
  const { dedupeKey, availableAt, ...workflowInput } = input
  await runWorkflowWithWorkerWake(
    workspaceSourcesSync.spec,
    { kind: "connection", ...workflowInput },
    dedupeKey || availableAt
      ? {
          idempotencyKey: dedupeKey
            ? `workspace-sources:${input.connectionId}:${dedupeKey}`
            : undefined,
          availableAt,
        }
      : undefined,
  )
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * The daily full sync (CTX-557): one sync without an event for each
 * connection that has an `ok` source and a sync adapter. A webhook syncs only
 * the changed item, so only this sync finds a root that the provider deleted
 * and counts its failures. Each connection starts at a fixed time of the UTC
 * day from a hash of its id, so the connections do not all start in the same
 * minute. When that time is already past (a worker that started late in the
 * day), the start is in the next hour, at the same spread. The key is per
 * connection per day, so a second call on the same day queues nothing.
 */
export async function enqueueDailySourcesSyncs(now: Date): Promise<number> {
  assertNotInOrgDbContext()
  const day = now.toISOString().slice(0, 10)
  const dayStart = Date.parse(`${day}T00:00:00.000Z`)
  let queued = 0
  for (const connection of await listConnectionsWithOkSources()) {
    const provider = fullSyncProvider(connection.provider)
    if (!provider) continue
    const offset =
      createHash("sha256")
        .update(connection.connectionId)
        .digest()
        .readUInt32BE(0) % DAY_MS
    const at = Math.max(dayStart + offset, now.getTime() + (offset % HOUR_MS))
    try {
      await enqueueConnectionSourcesSync({
        orgId: connection.orgId,
        connectionId: connection.connectionId,
        provider,
        dedupeKey: `daily:${day}`,
        availableAt: new Date(at),
      })
      queued += 1
    } catch (error) {
      log.error({
        step: "workspace_sources.enqueue_daily_sync",
        connectionId: connection.connectionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return queued
}

/**
 * "Sync now" on a connector: the same full sync as the daily one, now. The
 * key is per connection per minute, so a double click starts one sync.
 * Gives false when the connection has no `ok` source with a sync adapter.
 */
export async function requestConnectionSourcesSync(input: {
  orgId: string
  connectionId: string
  now: Date
}): Promise<boolean> {
  const rows = await listConnectionSourceRows({
    orgId: input.orgId,
    connectionId: input.connectionId,
    status: "ok",
  })
  const provider = rows
    .map((row) => fullSyncProvider(row.source.provider))
    .find((found) => found !== null)
  if (!provider) return false
  await enqueueConnectionSourcesSync({
    orgId: input.orgId,
    connectionId: input.connectionId,
    provider,
    manual: true,
    dedupeKey: `sync-now:${Math.floor(input.now.getTime() / 60_000)}`,
  })
  return true
}

/** A provider without a sync adapter (GitHub) has nothing to sync or clean up. */
function hasAdapter(provider: string | null): boolean {
  return provider !== null && Object.hasOwn(SOURCE_ADAPTERS, provider)
}

/**
 * The provider of a source when a full sync of it writes files. GitHub has
 * no sync adapter. Slack sources capture on demand, so a full Slack sync
 * writes nothing.
 */
function fullSyncProvider(provider: string | null): SourceProvider | null {
  const parsed = sourceProviderSchema.safeParse(provider)
  return parsed.success && parsed.data !== "slack" && hasAdapter(parsed.data)
    ? parsed.data
    : null
}

/**
 * After a projection: delete the managed files of removed or changed sources
 * that no other source owns, and sync each connection that gained or changed
 * an `ok` source.
 */
export async function enqueueSourceProjectionFollowUps(input: {
  orgId: string
  workspaceId: string
  /** The Workspace revision of the projection. */
  revision: string
  projected: {
    added: PlannedSourceRow[]
    changed: Array<{ before: WorkspaceSourceRow; after: PlannedSourceRow }>
    removed: WorkspaceSourceRow[]
  }
  /**
   * The committed publish pipeline. Only ingestion v2 retracts a repository
   * that left the sources (CTX-720).
   */
  publishPipeline: IngestionPublishPipeline
}): Promise<void> {
  assertNotInOrgDbContext()
  // Clean up only what left the file: the last good target of a removed
  // source, or of a changed source that now has a valid entry with another
  // target. A status change (a removed connection), an entry that became
  // invalid, and a file that cannot be read keep the committed files, as the
  // remove-connector dialog says.
  const left = [
    ...input.projected.removed.map(lastGoodTarget),
    ...input.projected.changed.map(({ before, after }) => {
      const target = lastGoodTarget(before)
      return after.status !== "invalid" && target && !sameSource(target, after)
        ? target
        : null
    }),
  ].filter((target): target is SourceTarget => target !== null)
  const removed = left.filter((target) => hasAdapter(target.provider))
  await enqueueRepositoryRetractions({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    revision: input.revision,
    publishPipeline: input.publishPipeline,
    left,
    kept: [
      ...input.projected.added,
      ...input.projected.changed.map((change) => change.after),
    ],
  })
  if (removed.length)
    await runWorkflowWithWorkerWake(workspaceSourcesSync.spec, {
      kind: "cleanup",
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      revision: input.revision,
      removed,
    })
  // A migrated legacy binding hands over to the sources after the merge.
  await handOverLegacyBindings({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    rows: [
      ...input.projected.added,
      ...input.projected.changed.map((change) => change.after),
    ],
  })
  const connections = new Map<string, SourceProvider>()
  for (const row of [
    ...input.projected.added,
    ...input.projected.changed.map((change) => change.after),
  ]) {
    const provider = sourceProviderSchema.safeParse(row.provider)
    if (
      row.status === "ok" &&
      row.connectionId &&
      provider.success &&
      hasAdapter(provider.data)
    )
      connections.set(row.connectionId, provider.data)
  }
  for (const [connectionId, provider] of connections) {
    try {
      await enqueueConnectionSourcesSync({
        orgId: input.orgId,
        connectionId,
        provider,
      })
    } catch (error) {
      log.error({
        step: "workspace_sources.enqueue_sync",
        connectionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** The normalized repository URLs of a GitHub target or row. */
function githubRepositoryUrls(source: {
  provider: string | null
  scope: unknown
}): string[] {
  if (source.provider !== "github") return []
  return githubSourceScopeRepositories(source.scope).map(({ name }) =>
    normalizeWorkspaceRepositoryUrl(`https://github.com/${name}`),
  )
}

/**
 * CTX-720 (ADR-052 section 3): a repository that left the sources loses what
 * ingestion v2 extracted from it. One host write job for each repository,
 * only while ingestion v2 publishes. A source entry that became invalid
 * keeps its repository, as it keeps its files (the CTX-710 rule above). A source that names the repository
 * after the projection keeps it; the job checks the sources at the tip again.
 * The job id is fixed for the revision, so a retry queues no second job.
 */
async function enqueueRepositoryRetractions(input: {
  orgId: string
  workspaceId: string
  revision: string
  publishPipeline: IngestionPublishPipeline
  left: ReadonlyArray<SourceTarget>
  kept: ReadonlyArray<PlannedSourceRow>
}): Promise<void> {
  const kept = new Set(input.kept.flatMap(githubRepositoryUrls))
  const repositories = [
    ...new Set(input.left.flatMap(githubRepositoryUrls)),
  ].filter((url) => !kept.has(url))
  if (!repositories.length || input.publishPipeline !== "v2") return
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  for (const url of repositories) {
    const jobId = `wjob_retract_${createHash("sha256")
      .update(`${input.workspaceId}\0${input.revision}\0${url}`)
      .digest("hex")
      .slice(0, 32)}`
    // Admission reads the Workspace in the org context.
    await withOrgIdContext(org, () =>
      enqueueWriteJob(
        {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          kind: "unlink_retraction",
          jobId,
          retractRepositoryUrl: url,
          publishPipeline: "v2",
        },
        {
          error: (error) =>
            log.error({
              step: "workspace_sources.enqueue_retraction",
              workspaceId: input.workspaceId,
              message: error.message,
            }),
        },
      ),
    )
  }
}
