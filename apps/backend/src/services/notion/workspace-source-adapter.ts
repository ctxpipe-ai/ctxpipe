import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  CONNECTION_TYPE_NOTION,
  connections,
} from "../../db/schema/connections.js"
import type {
  SourceAdapter,
  SourceFetchResult,
} from "../../domain/workspace-sources/adapter.js"
import type { NotionSourceScope } from "../../domain/workspace-sources/providers/notion.js"
import {
  countSourceFailure,
  type NotionSourceSync,
} from "../../lib/connection-config.js"
import { saveConnectionSourceSync } from "../../models/connection-source-sync.js"
import type { NotionConnection } from "../../models/notion-connector.js"
import { getLogger } from "../../observability/logger.js"
import type { GitFileChange } from "../git/file-change.js"
import {
  isNotionAuthFailure,
  NotionApiError,
  retrieveNotionDataSource,
  retrieveNotionPage,
} from "./client.js"
import {
  loadNotionConnection,
  loadNotionStoredConfig,
} from "./connection-load.js"
import { notionIdKey, titleSlug } from "./converter.js"
import {
  managedNotionPagePathsForSubtree,
  notionPageAncestry,
  parentDatabaseLikeId,
} from "./incremental.js"
import {
  captureNotionContent,
  createNotionTokenRefreshHandler,
} from "./sync.js"

/** The webhook event that the Notion route fans out to sources. */
export const notionSourceEventSchema = z.object({
  entityType: z.enum(["page", "database", "data_source"]),
  externalId: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
})
export type NotionSourceEvent = z.infer<typeof notionSourceEventSchema>

/**
 * A root that fails with a permanent Notion error (no access, not found) in
 * this many sync cycles goes out of access. Before that, the Workspace keeps
 * its last good copy.
 */
export const NOTION_SYNC_MAX_TRIES = 3

/** The Notion HTTP statuses that do not get better with a retry. */
const PERMANENT_STATUSES = new Set([400, 403, 404])

type NotionRoot = { kind: "page" | "database"; id: string; title: string }

function rootsOf(scope: NotionSourceScope): NotionRoot[] {
  return [
    ...(scope.pages ?? []).map((page) => ({ kind: "page" as const, ...page })),
    ...(scope.databases ?? []).map((database) => ({
      kind: "database" as const,
      ...database,
    })),
  ]
}

/** The folder of one root, as the mirror writes it (ADR-023). */
function rootPath(root: NotionRoot): string {
  return `notion/${root.kind === "page" ? "pages" : "databases"}/${titleSlug(root.title)}--${root.id}/`
}

const failureKey = (root: NotionRoot) => `${root.kind}:${root.id}`

function rootLabel(root: NotionRoot): string {
  return `Notion ${root.kind} "${root.title}" (${root.id})`
}

/** The text that a source of a revoked Notion connection shows. */
const RECONNECT_DETAIL =
  "Notion does not accept the ctxpipe access any more. Reconnect Notion on the Connectors page."

/** The connection, or why it cannot sync now. */
async function loadConnectionState(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<
  | { ready: true; connection: NotionConnection }
  | { ready: false; revoked: boolean }
> {
  const connection = await withOrgDbContext(orgId, () =>
    loadNotionConnection(orgId, connectionId, env),
  )
  if (connection?.accessToken && connection.status === "installed")
    return { ready: true, connection }
  return { ready: false, revoked: connection?.status === "revoked" }
}

/**
 * Mark the connection revoked after Notion refused its token (or the token
 * refresh), so the card asks for a reconnect. A new OAuth connect sets it
 * back to installed.
 */
async function markRevoked(orgId: string, connectionId: string) {
  await withOrgDbContext(orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`jsonb_set(${connections.config}, '{status}', '"revoked"'::jsonb)`,
      })
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      ),
  )
}

async function loadSourceSync(
  orgId: string,
  connectionId: string,
): Promise<NotionSourceSync> {
  const stored = await withOrgDbContext(orgId, () =>
    loadNotionStoredConfig(orgId, connectionId),
  )
  return stored?.sourceSync ?? { failures: {} }
}

/**
 * The roots that a webhook event can change: the roots whose files hold the
 * entity now, and the roots above it in Notion. Null means "all roots" (the
 * parent walk failed, so sync each root to be safe).
 */
async function rootsForEvent(input: {
  event: NotionSourceEvent
  roots: NotionRoot[]
  existingPaths: string[]
  env: Env
  connection: NotionConnection
  onTokenRefresh: ReturnType<typeof createNotionTokenRefreshHandler>
}): Promise<Set<string> | null> {
  const { event, roots } = input
  const affected = new Set<string>()
  const eventKey = notionIdKey(event.externalId)
  if (event.entityType !== "page") {
    for (const root of roots)
      if (root.kind === "database" && notionIdKey(root.id) === eventKey)
        affected.add(failureKey(root))
    return affected
  }
  const holding = managedNotionPagePathsForSubtree(
    input.existingPaths,
    event.externalId,
  )
  for (const root of roots)
    if (
      notionIdKey(root.id) === eventKey ||
      holding.some((path) => path.startsWith(rootPath(root)))
    )
      affected.add(failureKey(root))
  if (event.action === "delete") return affected
  try {
    const page = await retrieveNotionPage({
      env: input.env,
      connection: input.connection,
      pageId: event.externalId,
      onTokenRefresh: input.onTokenRefresh,
    })
    for await (const ancestor of notionPageAncestry({ ...input, page })) {
      const databaseId = parentDatabaseLikeId(ancestor)
      for (const root of roots) {
        const key = notionIdKey(root.id)
        if (
          (root.kind === "page" && key === notionIdKey(ancestor.id)) ||
          (root.kind === "database" &&
            databaseId &&
            key === notionIdKey(databaseId))
        )
          affected.add(failureKey(root))
      }
    }
  } catch (error) {
    // A page that is gone or not shared: the roots that hold it re-sync.
    if (error instanceof NotionApiError && PERMANENT_STATUSES.has(error.status))
      return affected
    return null
  }
  return affected
}

/**
 * The Notion adapter of the Workspace sources sync (ADR-050). It reuses the
 * mirror capture and its `notion/pages/` and `notion/databases/` layout, one
 * root at a time. A root always syncs its full subtree, so its files do not
 * depend on the other roots of the union, and the plain `fetch` form works.
 */
export const notionSourceAdapter: SourceAdapter<NotionSourceScope> = {
  provider: "notion",
  managedPaths: (scope) => rootsOf(scope).map(rootPath),
  async fetch({
    orgId,
    connectionId,
    scopes,
    env,
    event,
    existing,
    countFailures,
  }) {
    const roots = [
      ...new Map(
        scopes.flatMap(rootsOf).map((root) => [rootPath(root), root] as const),
      ).values(),
    ]
    const state = await loadConnectionState(orgId, connectionId, env)
    // A revoked connection keeps every file until a reconnect.
    if (!state.ready && state.revoked)
      return { files: [], keepPaths: roots.map(rootPath) }
    if (!state.ready)
      throw new Error("The Notion connection is not ready for sync")
    const { connection } = state
    const onTokenRefresh = createNotionTokenRefreshHandler({
      orgId,
      connectionId,
      env,
    })
    const parsedEvent = notionSourceEventSchema.safeParse(event)
    const affected = parsedEvent.success
      ? await rootsForEvent({
          event: parsedEvent.data,
          roots,
          existingPaths: (existing ?? []).map((file) => file.path),
          env,
          connection,
          onTokenRefresh,
        })
      : null
    const sourceSync = await loadSourceSync(orgId, connectionId)
    const failures = { ...sourceSync.failures }
    const result: Required<
      Pick<SourceFetchResult, "keepPaths" | "unreachable">
    > & { files: GitFileChange[]; deletePaths: string[] } = {
      files: [],
      deletePaths: [],
      keepPaths: [],
      unreachable: [],
    }
    const existingPaths = (existing ?? []).map((file) => file.path)
    const now = new Date()
    let revoked = false
    for (const root of roots) {
      const prefix = rootPath(root)
      const key = failureKey(root)
      if (revoked || (affected && !affected.has(key))) {
        result.keepPaths.push(prefix)
        continue
      }
      const blobs = (existing ?? [])
        .filter((file) => file.path.startsWith(prefix))
        // A path whose blob differs between Workspaces is written again.
        .map((file) => ({ path: file.path, sha: file.sha ?? "" }))
      const captured = await captureNotionContent({
        orgId,
        env,
        notionConnection: connection,
        config: {
          resources: [
            { externalId: root.id, type: root.kind, title: root.title },
          ],
        },
        existingPaths: blobs.map((file) => file.path),
        existingBlobs: existing ? blobs : undefined,
        rootTitlesFromConfig: true,
        // A child page, row, or block that ctxpipe cannot read keeps its files.
        onUnreadable: (id, error) => {
          result.keepPaths.push(
            ...managedNotionPagePathsForSubtree(existingPaths, id),
          )
          getLogger().warn("Notion source skipped an unreadable child", {
            step: "notion.sources.unreadable",
            connectionId,
            root: root.id,
            id,
            status: error.status,
          })
        },
      })
      const [error] = captured.errors
      if (!error) {
        delete failures[key]
        result.files.push(...captured.files)
        result.deletePaths.push(...captured.deletePaths)
        continue
      }
      result.keepPaths.push(prefix)
      if (error.status === 401) {
        revoked = true
        await markRevoked(orgId, connectionId)
        getLogger().warn(
          "Notion refused the token; the connection is revoked",
          {
            step: "notion.sources.revoked",
            connectionId,
          },
        )
        continue
      }
      if (!error.status || !PERMANENT_STATUSES.has(error.status)) {
        // A provider outage: keep the last good copy, and do not count it.
        getLogger().warn("Notion source root capture failed", {
          step: "notion.sources.capture",
          connectionId,
          error: error.message,
        })
        continue
      }
      const counted = countSourceFailure({
        count: countFailures,
        failures,
        key,
        now,
        detail: (tries) =>
          `${rootLabel(root)} failed ${tries} syncs: ctxpipe cannot read it (${error.status}). Share it with the ctxpipe integration in Notion, or remove it from the source.`,
      })
      if (counted && counted.tries >= NOTION_SYNC_MAX_TRIES)
        result.unreachable.push({
          path: prefix,
          status: "out_of_access",
          detail: counted.detail,
        })
    }
    // A full sync sees every root, so it drops the counts of removed roots.
    const current = new Set(roots.map(failureKey))
    await saveConnectionSourceSync({
      type: "notion",
      orgId,
      connectionId,
      sourceSync: {
        failures: Object.fromEntries(
          Object.entries(failures).filter(
            ([key]) => event !== undefined || current.has(key),
          ),
        ),
      },
    })
    const kept = result.keepPaths.filter(
      (path) => !result.unreachable.some((lost) => lost.path === path),
    )
    return existing
      ? { ...result, keepPaths: kept }
      : {
          files: result.files,
          keepPaths: kept,
          unreachable: result.unreachable,
        }
  },
  async checkAccess({ orgId, connectionId, scope, env }) {
    const state = await loadConnectionState(orgId, connectionId, env)
    if (!state.ready)
      return state.revoked
        ? RECONNECT_DETAIL
        : "The Notion connection is not ready"
    const { connection } = state
    const onTokenRefresh = createNotionTokenRefreshHandler({
      orgId,
      connectionId,
      env,
    })
    const sourceSync = await loadSourceSync(orgId, connectionId)
    const problems: string[] = []
    for (const root of rootsOf(scope)) {
      try {
        if (root.kind === "page")
          await retrieveNotionPage({
            env,
            connection,
            pageId: root.id,
            onTokenRefresh,
          })
        else
          await retrieveNotionDataSource({
            env,
            connection,
            dataSourceId: root.id,
            onTokenRefresh,
          })
      } catch (error) {
        if (isNotionAuthFailure(error)) {
          await markRevoked(orgId, connectionId)
          return RECONNECT_DETAIL
        }
        if (
          error instanceof NotionApiError &&
          PERMANENT_STATUSES.has(error.status)
        ) {
          problems.push(
            `${rootLabel(root)} does not exist, or it is not shared with the ctxpipe integration`,
          )
          continue
        }
        // During an outage, a failure that the sync recorded still shows.
        const recorded = sourceSync.failures[failureKey(root)]
        if (recorded && recorded.tries >= NOTION_SYNC_MAX_TRIES)
          problems.push(recorded.detail)
      }
    }
    return problems.length ? problems.join("; ") : null
  },
  async syncStatus({ orgId, connectionId }) {
    const stored = await withOrgDbContext(orgId, () =>
      loadNotionStoredConfig(orgId, connectionId),
    )
    return stored?.status === "revoked"
      ? { status: "out_of_access" as const, detail: RECONNECT_DETAIL }
      : null
  },
  matchesEvent: ({ event, scope }) => {
    const parsed = notionSourceEventSchema.safeParse(event)
    // A page event can be deep in any root; the fetch finds its roots.
    if (!parsed.success || parsed.data.entityType === "page") return true
    const key = notionIdKey(parsed.data.externalId)
    return (scope.databases ?? []).some(
      (database) => notionIdKey(database.id) === key,
    )
  },
}
