import { z } from "zod"
import type { Env } from "../../config/env.js"
import { formatUnknownError } from "../../db/transientDbRetry.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import type { ZendeskSourceScope } from "../../domain/workspace-sources/providers/zendesk.js"
import { countSourceFailure } from "../../lib/connection-config.js"
import { saveConnectionSourceSync } from "../../models/connection-source-sync.js"
import {
  getZendeskConnection,
  getZendeskConnectionStatus,
  markZendeskConnectionRevoked,
  type ZendeskConnection,
} from "../../models/zendesk-connector.js"
import { log } from "../../observability/logger.js"
import { connectorCommitFileUnchanged } from "../connectors/assets.js"
import type { GitFileChange } from "../git/file-change.js"
import { freshZendeskAccessToken } from "./access-token.js"
import {
  listZendeskCategories,
  listZendeskCategoryArticles,
  listZendeskViews,
  listZendeskViewTickets,
} from "./client.js"
import {
  zendeskArticleFile,
  zendeskCategoryRoot,
  zendeskTicketFile,
  zendeskViewRoot,
} from "./converter.js"
import { ZendeskAuthorizationRevokedError } from "./oauth.js"

/**
 * A category or view that is gone or out of reach (404 or 403) in this many
 * sync cycles goes out of access. Before that, the Workspace keeps its copy.
 */
export const ZENDESK_SYNC_MAX_TRIES = 3

const RECONNECT_DETAIL =
  "Zendesk does not accept the authorization of this connection any more. Reconnect Zendesk on the Connectors page."

/**
 * The event of an article webhook. Ticket views have no events (Zendesk
 * sends them only through a trigger), so this sync reads only categories.
 */
export const zendeskArticleEventSchema = z.object({
  kind: z.literal("articles"),
})
export type ZendeskArticleEvent = z.infer<typeof zendeskArticleEventSchema>

type Item = { kind: "category" | "view"; id: string; root: string }

const label = (item: Item) =>
  item.kind === "category"
    ? `Zendesk Help Center category ${item.id}`
    : `Zendesk view ${item.id}`

function missingDetail(item: Item, reason: "not_found" | "forbidden") {
  return reason === "not_found"
    ? `${label(item)} does not exist. Remove it from the source.`
    : `ctx| cannot read ${label(item)}. Give the Zendesk user access to it, or remove it from the source.`
}

function items(scopes: readonly ZendeskSourceScope[]): Item[] {
  const unique = (values: string[]) => [...new Set(values)]
  return [
    ...unique(scopes.flatMap((scope) => scope.categories ?? [])).map(
      (id): Item => ({ kind: "category", id, root: zendeskCategoryRoot(id) }),
    ),
    ...unique(scopes.flatMap((scope) => scope.views ?? [])).map(
      (id): Item => ({ kind: "view", id, root: zendeskViewRoot(id) }),
    ),
  ]
}

async function loadConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<ZendeskConnection> {
  const connection = await getZendeskConnection(orgId, connectionId, env)
  if (!connection) throw new Error("The Zendesk connection does not exist")
  return connection
}

/** The files of one category or view, or why the provider refused it. */
async function readItem(
  auth: { subdomain: string; accessToken: string },
  item: Item,
): Promise<GitFileChange[] | "not_found" | "forbidden"> {
  if (item.kind === "category") {
    const articles = await listZendeskCategoryArticles({
      ...auth,
      categoryId: item.id,
    })
    return typeof articles === "string"
      ? articles
      : articles.map((article) =>
          zendeskArticleFile({ categoryId: item.id, article }),
        )
  }
  const tickets = await listZendeskViewTickets({ ...auth, viewId: item.id })
  return typeof tickets === "string"
    ? tickets
    : tickets.map((ticket) => zendeskTicketFile({ viewId: item.id, ticket }))
}

/**
 * The Zendesk adapter of the Workspace sources sync (ADR-054). Each sync
 * reads each selected category (its articles) and each selected view (its
 * latest tickets), and writes them under `zendesk/`. An item that left a
 * category or a view goes away in the same commit.
 */
export const zendeskSourceAdapter: SourceAdapter<ZendeskSourceScope> = {
  provider: "zendesk",
  managedPaths: (scope) => items([scope]).map((item) => item.root),
  async fetch({
    orgId,
    connectionId,
    scopes,
    env,
    event,
    existing,
    countFailures,
  }) {
    const all = items(scopes)
    const roots = all.map((item) => item.root)
    const articlesOnly = zendeskArticleEventSchema.safeParse(event).success
    const selected = articlesOnly
      ? all.filter((item) => item.kind === "category")
      : all
    const connection = await loadConnection(orgId, connectionId, env)
    // A revoked connection keeps every file until a reconnect.
    if (connection.status === "revoked") return { files: [], keepPaths: roots }
    if (connection.status !== "installed")
      throw new Error("The Zendesk connection is not ready for sync")
    let accessToken: string
    try {
      accessToken = await freshZendeskAccessToken({ orgId, env, connection })
    } catch (error) {
      if (error instanceof ZendeskAuthorizationRevokedError)
        return { files: [], keepPaths: roots }
      throw error
    }

    const shas = new Map(
      (existing ?? []).flatMap((file) =>
        file.sha ? [[file.path, file.sha] as const] : [],
      ),
    )
    const failures = { ...connection.sourceSync?.failures }
    const files: GitFileChange[] = []
    const deletePaths: string[] = []
    // An article event keeps the ticket files as they are.
    const keepPaths: string[] = articlesOnly
      ? all.filter((item) => item.kind === "view").map((item) => item.root)
      : []
    const unreachable: Array<{
      path: string
      status: "out_of_access"
      detail: string
    }> = []
    const now = new Date()
    let revoked = false
    for (const item of selected) {
      const key = `${item.kind}:${item.id}`
      if (revoked) {
        keepPaths.push(item.root)
        continue
      }
      try {
        const read = await readItem(
          { subdomain: connection.subdomain, accessToken },
          item,
        )
        if (typeof read === "string") {
          keepPaths.push(item.root)
          const counted = countSourceFailure({
            count: countFailures,
            failures,
            key,
            now,
            detail: (tries) =>
              `${missingDetail(item, read)} (${tries} failed syncs)`,
          })
          if (counted && counted.tries >= ZENDESK_SYNC_MAX_TRIES)
            unreachable.push({
              path: item.root,
              status: "out_of_access",
              detail: counted.detail,
            })
          continue
        }
        delete failures[key]
        // A patch: the changed files, and the items that left the scope.
        const desired = new Set(read.map((file) => file.path))
        files.push(
          ...read.filter((file) => !connectorCommitFileUnchanged(file, shas)),
        )
        deletePaths.push(
          ...(existing ?? [])
            .map((file) => file.path)
            .filter((path) => path.startsWith(item.root) && !desired.has(path)),
        )
      } catch (error) {
        keepPaths.push(item.root)
        if (error instanceof ZendeskAuthorizationRevokedError) {
          revoked = true
          // A token that expired during this sync is not a revoke: the next
          // sync refreshes it.
          const expired =
            connection.accessTokenExpiresAt !== null &&
            Date.parse(connection.accessTokenExpiresAt) <= Date.now()
          if (connection.accessTokenEnc && !expired)
            await markZendeskConnectionRevoked({
              orgId,
              connectionId,
              accessTokenEnc: connection.accessTokenEnc,
            })
          continue
        }
        // A provider outage: keep the last copy, and do not count it.
        log.warn({
          step: "zendesk.sources.capture",
          connectionId,
          item: key,
          message: formatUnknownError(error),
        })
      }
    }
    // A full sync sees every item, so it drops the counts of removed ones.
    await saveConnectionSourceSync({
      type: "zendesk",
      orgId,
      connectionId,
      sourceSync: {
        failures: Object.fromEntries(
          Object.entries(failures).filter(([key]) =>
            all.some((item) => `${item.kind}:${item.id}` === key),
          ),
        ),
      },
    })
    const kept = keepPaths.filter(
      (path) => !unreachable.some((lost) => lost.path === path),
    )
    return { files, deletePaths, keepPaths: kept, unreachable }
  },
  /** Two list reads (categories, views) answer for every item of a scope. */
  async checkAccess({ orgId, connectionId, scope, env }) {
    const connection = await loadConnection(orgId, connectionId, env)
    if (connection.status === "revoked") return RECONNECT_DETAIL
    if (connection.status !== "installed")
      return "The Zendesk connection is not ready"
    try {
      const auth = {
        subdomain: connection.subdomain,
        accessToken: await freshZendeskAccessToken({ orgId, env, connection }),
      }
      const problems: string[] = []
      if (scope.categories?.length) {
        const known = new Set(
          (await listZendeskCategories(auth)).map((category) => category.id),
        )
        for (const id of scope.categories)
          if (!known.has(id))
            problems.push(
              `ctx| cannot read Zendesk Help Center category ${id}. Check that it exists, and that the Zendesk user can read it.`,
            )
      }
      if (scope.views?.length) {
        const known = new Set(
          (await listZendeskViews(auth)).map((view) => view.id),
        )
        for (const id of scope.views)
          if (!known.has(id))
            problems.push(
              `ctx| cannot read Zendesk view ${id}. Check that it exists, is active, and is shared with the Zendesk user.`,
            )
      }
      return problems.length ? problems.join("; ") : null
    } catch (error) {
      if (error instanceof ZendeskAuthorizationRevokedError)
        return RECONNECT_DETAIL
      throw error
    }
  },
  /** An article event touches only the sources that select a category. */
  matchesEvent: ({ event, scope }) =>
    !zendeskArticleEventSchema.safeParse(event).success ||
    Boolean(scope.categories?.length),
  async syncStatus({ orgId, connectionId }) {
    return (await getZendeskConnectionStatus(orgId, connectionId)) === "revoked"
      ? { status: "out_of_access" as const, detail: RECONNECT_DETAIL }
      : null
  },
}
