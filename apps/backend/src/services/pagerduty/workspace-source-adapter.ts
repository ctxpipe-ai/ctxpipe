import { and, eq } from "drizzle-orm"
import { z } from "zod"

import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
  connections,
} from "../../db/schema/connections.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import type { PagerdutySourceScope } from "../../domain/workspace-sources/providers/pagerduty.js"
import {
  countSourceFailure,
  type PagerdutySourceSync,
  parsePagerdutyConnectionStored,
} from "../../lib/connection-config.js"
import { saveConnectionSourceSync } from "../../models/connection-source-sync.js"
import {
  getPagerdutyConnectionByConnectionId,
  type PagerdutyConnection,
  recordPagerdutyOAuthRevocation,
} from "../../models/pagerduty-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  connectorCommitFileUnchanged,
  connectorPathMatchesPreservation,
  createConnectorAssetBudget,
  createConnectorAssetBytePool,
} from "../connectors/assets.js"
import type { GitFileChange } from "../git/file-change.js"
import {
  getPagerdutyIncident,
  getPagerdutyService,
  isPagerdutyAuthorizationRevokedError,
  listPagerdutyIncidentIdsForService,
} from "./client.js"
import {
  pagerdutyManagedPathsForIncidentId,
  pagerdutyServiceIncidentsRoot,
} from "./converter.js"
import { capturePagerdutyIncidentAssets } from "./sync-assets.js"
import { resolveFreshAccessToken } from "./sync.js"

/** The webhook event that the PagerDuty route fans out to sources. */
export const pagerdutySourceEventSchema = z.object({
  incidentId: z.string().min(1),
  serviceId: z.string().min(1),
})
export type PagerdutySourceEvent = z.infer<typeof pagerdutySourceEventSchema>

/**
 * A service that is gone or out of reach (404 or 403) in this many sync
 * cycles goes out of access. Before that, the Workspace keeps its last copy.
 */
export const PAGERDUTY_SYNC_MAX_TRIES = 3

/** The text that a source of a revoked PagerDuty connection shows. */
const RECONNECT_DETAIL =
  "PagerDuty does not accept the ctxpipe access any more. Reconnect PagerDuty on the Connectors page."

const failureKey = (serviceId: string) => `service:${serviceId}`

function missingDetail(serviceId: string, reason: "not_found" | "forbidden") {
  return reason === "not_found"
    ? `PagerDuty service ${serviceId} does not exist. Remove it from the source.`
    : `ctxpipe cannot read PagerDuty service ${serviceId}. Give the PagerDuty connection access to it, or remove it from the source.`
}

type ConnectionState =
  | {
      ready: true
      connection: PagerdutyConnection
      sourceSync: PagerdutySourceSync
    }
  | { ready: false; revoked: boolean }

async function loadConnectionState(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<ConnectionState> {
  const connection = await getPagerdutyConnectionByConnectionId(
    orgId,
    connectionId,
    env,
  )
  if (!connection?.accessToken || connection.status !== "installed")
    return { ready: false, revoked: connection?.status === "revoked" }
  return {
    ready: true,
    connection,
    sourceSync: await loadSourceSync(orgId, connectionId),
  }
}

async function loadStoredConfig(orgId: string, connectionId: string) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1),
  )
  return row
    ? parsePagerdutyConnectionStored(row.config as Record<string, unknown>)
    : null
}

async function loadSourceSync(
  orgId: string,
  connectionId: string,
): Promise<PagerdutySourceSync> {
  return (
    (await loadStoredConfig(orgId, connectionId))?.sourceSync ?? {
      failures: {},
    }
  )
}

/** Mark the connection revoked, so the card asks for a reconnect. */
async function markRevoked(
  orgId: string,
  connection: PagerdutyConnection,
  env: Env,
) {
  if (!connection.accessToken) return
  const expectedAccessToken = connection.accessToken
  await withOrgDbContext(orgId, () =>
    recordPagerdutyOAuthRevocation({
      orgId,
      connectionId: connection.id,
      env,
      expectedAccessToken,
    }),
  )
}

type Capture = { files: GitFileChange[]; preserve: string[] }

/** Capture one incident into the folder of its service. */
async function captureIncident(input: {
  incident: Exclude<
    Awaited<ReturnType<typeof getPagerdutyIncident>>,
    "not_found"
  >
  bytePool?: ReturnType<typeof createConnectorAssetBytePool>
}): Promise<Capture> {
  const captured = await capturePagerdutyIncidentAssets({
    incident: input.incident,
    budget: createConnectorAssetBudget(),
    bytePool: input.bytePool,
    root: pagerdutyServiceIncidentsRoot(input.incident.serviceId),
  })
  return { files: captured.files, preserve: captured.preservePathPrefixes }
}

/** The stale paths under `prefixes`: not written now and not preserved. */
function stalePaths(input: {
  existing: readonly string[]
  prefixes: readonly string[]
  capture: Capture
}): string[] {
  const desired = new Set(input.capture.files.map((file) => file.path))
  return input.existing.filter(
    (path) =>
      input.prefixes.some((prefix) => path.startsWith(prefix)) &&
      !desired.has(path) &&
      !input.capture.preserve.some((preserve) =>
        connectorPathMatchesPreservation(path, preserve),
      ),
  )
}

function withoutUnchanged(
  files: GitFileChange[],
  existing: ReadonlyArray<{ path: string; sha: string | null }> | undefined,
): GitFileChange[] {
  if (!existing) return files
  const shas = new Map(
    existing.flatMap((file) =>
      file.sha ? [[file.path, file.sha] as const] : [],
    ),
  )
  return files.filter((file) => !connectorCommitFileUnchanged(file, shas))
}

/**
 * The PagerDuty adapter of the Workspace sources sync (ADR-034, ADR-050). It
 * reuses the mirror capture (incident Markdown with alerts folded in, the
 * same caps) and writes each service under
 * `pagerduty/services/<serviceId>/incidents/`, because the sync frame gives
 * ownership by path prefix.
 */
export const pagerdutySourceAdapter: SourceAdapter<PagerdutySourceScope> = {
  provider: "pagerduty",
  managedPaths: (scope) => scope.services.map(pagerdutyServiceIncidentsRoot),
  async fetch({
    orgId,
    connectionId,
    scopes,
    env,
    event,
    existing,
    countFailures,
  }) {
    const serviceIds = [...new Set(scopes.flatMap((scope) => scope.services))]
    const roots = serviceIds.map(pagerdutyServiceIncidentsRoot)
    const existingPaths = (existing ?? []).map((file) => file.path)
    const parsedEvent = pagerdutySourceEventSchema.safeParse(event)
    // The files of the event incident in each source, also under the root of
    // its old service, so a service change moves the file.
    const prior = parsedEvent.success
      ? roots.flatMap((root) =>
          pagerdutyManagedPathsForIncidentId(
            existingPaths,
            parsedEvent.data.incidentId,
            root,
          ),
        )
      : []
    // An incident that no source has or selects: nothing to fetch.
    if (
      parsedEvent.success &&
      !prior.length &&
      !serviceIds.includes(parsedEvent.data.serviceId)
    )
      return { files: [], deletePaths: [] }
    const state = await loadConnectionState(orgId, connectionId, env)
    // A revoked connection keeps every file until a reconnect.
    if (!state.ready && state.revoked) return { files: [], keepPaths: roots }
    if (!state.ready)
      throw new Error("The PagerDuty connection is not ready for sync")
    const { connection } = state
    let accessToken: string
    try {
      accessToken = await resolveFreshAccessToken({ orgId, env, connection })
    } catch (error) {
      if (isPagerdutyAuthorizationRevokedError(error))
        return { files: [], keepPaths: roots }
      throw error
    }

    if (parsedEvent.success) {
      // One incident changed: a patch of its files only.
      const { incidentId } = parsedEvent.data
      let incident: Awaited<ReturnType<typeof getPagerdutyIncident>>
      try {
        incident = await getPagerdutyIncident({
          accessToken,
          region: connection.region,
          incidentId,
        })
      } catch (error) {
        if (isPagerdutyAuthorizationRevokedError(error)) {
          await markRevoked(orgId, connection, env)
          return { files: [], keepPaths: roots }
        }
        throw error
      }
      if (incident === "not_found" || !serviceIds.includes(incident.serviceId))
        return { files: [], deletePaths: prior }
      const capture = await captureIncident({ incident })
      return {
        files: withoutUnchanged(capture.files, existing),
        deletePaths: stalePaths({ existing: prior, prefixes: roots, capture }),
      }
    }

    // A full sync: each service on its own, so one failure skips only it.
    const failures = { ...state.sourceSync.failures }
    const files: GitFileChange[] = []
    const deletePaths: string[] = []
    const keepPaths: string[] = []
    const unreachable: Array<{
      path: string
      status: "out_of_access"
      detail: string
    }> = []
    const bytePool = createConnectorAssetBytePool()
    const now = new Date()
    let revoked = false
    for (const serviceId of serviceIds) {
      const root = pagerdutyServiceIncidentsRoot(serviceId)
      const key = failureKey(serviceId)
      if (revoked) {
        keepPaths.push(root)
        continue
      }
      try {
        const service = await getPagerdutyService({
          accessToken,
          region: connection.region,
          serviceId,
        })
        if (service === "not_found" || service === "forbidden") {
          keepPaths.push(root)
          const counted = countSourceFailure({
            count: countFailures,
            failures,
            key,
            now,
            detail: (tries) =>
              `${missingDetail(serviceId, service)} (${tries} failed syncs)`,
          })
          if (counted && counted.tries >= PAGERDUTY_SYNC_MAX_TRIES)
            unreachable.push({
              path: root,
              status: "out_of_access",
              detail: counted.detail,
            })
          continue
        }
        const capture: Capture = { files: [], preserve: [] }
        const incidentIds = await listPagerdutyIncidentIdsForService({
          accessToken,
          region: connection.region,
          serviceId,
        })
        for (const incidentId of incidentIds) {
          const incident = await getPagerdutyIncident({
            accessToken,
            region: connection.region,
            incidentId,
          })
          if (incident === "not_found" || incident.serviceId !== serviceId)
            continue
          const captured = await captureIncident({ incident, bytePool })
          capture.files.push(...captured.files)
          capture.preserve.push(...captured.preserve)
        }
        delete failures[key]
        files.push(...withoutUnchanged(capture.files, existing))
        deletePaths.push(
          ...stalePaths({ existing: existingPaths, prefixes: [root], capture }),
        )
        // Without the existing files, keep the assets that did not download.
        if (!existing) keepPaths.push(...capture.preserve)
      } catch (error) {
        keepPaths.push(root)
        if (isPagerdutyAuthorizationRevokedError(error)) {
          revoked = true
          await markRevoked(orgId, connection, env)
          continue
        }
        // A provider outage: keep the last copy, and do not count it.
        getLogger().warn("PagerDuty source service capture failed", {
          step: "pagerduty.sources.capture",
          connectionId,
          serviceId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // A full sync sees every service, so it drops the counts of removed ones.
    await saveConnectionSourceSync({
      type: "pagerduty",
      orgId,
      connectionId,
      sourceSync: {
        failures: Object.fromEntries(
          Object.entries(failures).filter(([key]) =>
            serviceIds.some((serviceId) => failureKey(serviceId) === key),
          ),
        ),
      },
    })
    const kept = keepPaths.filter(
      (path) => !unreachable.some((lost) => lost.path === path),
    )
    return existing
      ? { files, deletePaths, keepPaths: kept, unreachable }
      : { files, keepPaths: kept, unreachable }
  },
  async checkAccess({ orgId, connectionId, scope, env }) {
    const state = await loadConnectionState(orgId, connectionId, env)
    if (!state.ready)
      return state.revoked
        ? RECONNECT_DETAIL
        : "The PagerDuty connection is not ready"
    const { connection, sourceSync } = state
    let accessToken: string
    try {
      accessToken = await resolveFreshAccessToken({ orgId, env, connection })
    } catch (error) {
      if (isPagerdutyAuthorizationRevokedError(error)) return RECONNECT_DETAIL
      throw error
    }
    const problems: string[] = []
    for (const serviceId of scope.services) {
      try {
        const service = await getPagerdutyService({
          accessToken,
          region: connection.region,
          serviceId,
        })
        if (service === "not_found" || service === "forbidden")
          problems.push(missingDetail(serviceId, service))
      } catch (error) {
        if (isPagerdutyAuthorizationRevokedError(error)) {
          await markRevoked(orgId, connection, env)
          return RECONNECT_DETAIL
        }
        // During an outage, a failure that the sync recorded still shows.
        const recorded = sourceSync.failures[failureKey(serviceId)]
        if (recorded && recorded.tries >= PAGERDUTY_SYNC_MAX_TRIES)
          problems.push(recorded.detail)
      }
    }
    return problems.length ? problems.join("; ") : null
  },
  async syncStatus({ orgId, connectionId }) {
    const stored = await loadStoredConfig(orgId, connectionId)
    return stored?.status === "revoked"
      ? { status: "out_of_access" as const, detail: RECONNECT_DETAIL }
      : null
  },
  /**
   * Each source takes an incident event: the incident can have moved from a
   * service of one source to a service of another. The fetch reads the
   * incident one time and patches only its files.
   */
  matchesEvent: ({ event }) =>
    pagerdutySourceEventSchema.safeParse(event).success,
}
