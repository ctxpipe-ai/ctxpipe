import { z } from "zod"

import type { Env } from "../../config/env.js"
import { formatUnknownError } from "../../db/transientDbRetry.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import type { PlainSourceScope } from "../../domain/workspace-sources/providers/plain.js"
import { countSourceFailure } from "../../lib/connection-config.js"
import { saveConnectionSourceSync } from "../../models/connection-source-sync.js"
import {
  getPlainConnection,
  getPlainConnectionStatus,
  markPlainConnectionRevoked,
  type PlainConnection,
} from "../../models/plain-connector.js"
import { getLogger } from "../../observability/logger.js"
import { connectorCommitFileUnchanged } from "../connectors/assets.js"
import type { GitFileChange } from "../git/file-change.js"
import {
  listPlainHelpCenterArticles,
  listPlainHelpCenters,
  listPlainLabelThreads,
  listPlainLabelTypes,
  PlainUnauthorizedError,
} from "./client.js"
import {
  plainArticleFile,
  plainHelpCenterRoot,
  plainLabelRoot,
  plainThreadFile,
} from "./converter.js"

/**
 * A Help Center or label that is gone in this many sync cycles goes out of
 * access. Before that, the Workspace keeps its copy.
 */
export const PLAIN_SYNC_MAX_TRIES = 3

const RECONNECT_DETAIL =
  "Plain does not accept the API key of this connection any more. Reconnect Plain on the Connectors page."

/**
 * The event of the webhook target: thread activity. Help Center articles
 * have no Plain events, so this sync reads only labels.
 */
export const plainThreadEventSchema = z.object({ kind: z.literal("threads") })
export type PlainThreadEvent = z.infer<typeof plainThreadEventSchema>

type Item = { kind: "helpCenter" | "label"; id: string; root: string }

const label = (item: Item) =>
  item.kind === "helpCenter"
    ? `Plain Help Center ${item.id}`
    : `Plain label ${item.id}`

function items(scopes: readonly PlainSourceScope[]): Item[] {
  const unique = (values: string[]) => [...new Set(values)]
  return [
    ...unique(scopes.flatMap((scope) => scope.helpCenters ?? [])).map(
      (id): Item => ({ kind: "helpCenter", id, root: plainHelpCenterRoot(id) }),
    ),
    ...unique(scopes.flatMap((scope) => scope.labels ?? [])).map(
      (id): Item => ({ kind: "label", id, root: plainLabelRoot(id) }),
    ),
  ]
}

async function loadConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<PlainConnection> {
  const connection = await getPlainConnection(orgId, connectionId, env)
  if (!connection) throw new Error("The Plain connection does not exist")
  return connection
}

/** The files of one Help Center or label, or `not_found`. */
async function readItem(
  apiKey: string,
  item: Item,
): Promise<GitFileChange[] | "not_found"> {
  if (item.kind === "helpCenter") {
    const articles = await listPlainHelpCenterArticles({
      apiKey,
      helpCenterId: item.id,
    })
    return typeof articles === "string"
      ? articles
      : articles.map((article) =>
          plainArticleFile({ helpCenterId: item.id, article }),
        )
  }
  const threads = await listPlainLabelThreads({ apiKey, labelTypeId: item.id })
  return typeof threads === "string"
    ? threads
    : threads.map((thread) => plainThreadFile({ labelTypeId: item.id, thread }))
}

/**
 * The Plain adapter of the Workspace sources sync (ADR-059). Each sync reads
 * each selected Help Center (its published articles) and each selected
 * label (its newest threads), and writes them under `plain/`. An item that
 * left a Help Center or a label goes away in the same commit.
 */
export const plainSourceAdapter: SourceAdapter<PlainSourceScope> = {
  provider: "plain",
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
    const threadsOnly = plainThreadEventSchema.safeParse(event).success
    const selected = threadsOnly
      ? all.filter((item) => item.kind === "label")
      : all
    const connection = await loadConnection(orgId, connectionId, env)
    // A revoked connection keeps every file until a reconnect.
    if (connection.status === "revoked") return { files: [], keepPaths: roots }

    const shas = new Map(
      (existing ?? []).flatMap((file) =>
        file.sha ? [[file.path, file.sha] as const] : [],
      ),
    )
    const failures = { ...connection.sourceSync?.failures }
    const files: GitFileChange[] = []
    const deletePaths: string[] = []
    // A thread event keeps the article files as they are.
    const keepPaths: string[] = threadsOnly
      ? all
          .filter((item) => item.kind === "helpCenter")
          .map((item) => item.root)
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
        const read = await readItem(connection.apiKey, item)
        if (read === "not_found") {
          keepPaths.push(item.root)
          const counted = countSourceFailure({
            count: countFailures,
            failures,
            key,
            now,
            detail: (tries) =>
              `${label(item)} does not exist. Remove it from the source. (${tries} failed syncs)`,
          })
          if (counted && counted.tries >= PLAIN_SYNC_MAX_TRIES)
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
        if (error instanceof PlainUnauthorizedError) {
          revoked = true
          await markPlainConnectionRevoked({
            orgId,
            connectionId,
            apiKeyEnc: connection.apiKeyEnc,
          })
          continue
        }
        // A provider outage: keep the last copy, and do not count it.
        getLogger().warn("Plain source item capture failed", {
          step: "plain.sources.capture",
          connectionId,
          item: key,
          error: formatUnknownError(error),
        })
      }
    }
    // A full sync sees every item, so it drops the counts of removed ones.
    await saveConnectionSourceSync({
      type: "plain",
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
  /** Two list reads (Help Centers, labels) answer for every item of a scope. */
  async checkAccess({ orgId, connectionId, scope, env }) {
    const connection = await loadConnection(orgId, connectionId, env)
    if (connection.status === "revoked") return RECONNECT_DETAIL
    try {
      const problems: string[] = []
      if (scope.helpCenters?.length) {
        const known = new Set(
          (await listPlainHelpCenters(connection.apiKey)).map(
            (center) => center.id,
          ),
        )
        for (const id of scope.helpCenters)
          if (!known.has(id))
            problems.push(
              `ctxpipe cannot read Plain Help Center ${id}. Check that it exists.`,
            )
      }
      if (scope.labels?.length) {
        const known = new Set(
          (await listPlainLabelTypes(connection.apiKey)).map(
            (labelType) => labelType.id,
          ),
        )
        for (const id of scope.labels)
          if (!known.has(id))
            problems.push(
              `ctxpipe cannot read Plain label ${id}. Check that it exists and is not archived.`,
            )
      }
      return problems.length ? problems.join("; ") : null
    } catch (error) {
      if (error instanceof PlainUnauthorizedError) return RECONNECT_DETAIL
      throw error
    }
  },
  /** A thread event touches only the sources that select a label. */
  matchesEvent: ({ event, scope }) =>
    !plainThreadEventSchema.safeParse(event).success ||
    Boolean(scope.labels?.length),
  async syncStatus({ orgId, connectionId }) {
    return (await getPlainConnectionStatus(orgId, connectionId)) === "revoked"
      ? { status: "out_of_access" as const, detail: RECONNECT_DETAIL }
      : null
  },
}
