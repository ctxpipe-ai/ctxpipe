import { z } from "zod"

import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import type { ConfluenceSourceScope } from "../../domain/workspace-sources/providers/confluence.js"
import type { ForgeSourceSync } from "../../lib/connection-config.js"
import { getForgeInstallationByConnectionId } from "../../models/atlassian-connector.js"
import { saveConnectionSourceSync } from "../../models/connection-source-sync.js"
import { getLogger } from "../../observability/logger.js"
import type { GitFileChange } from "../git/file-change.js"
import { listConfluenceSpaces } from "./client.js"
import {
  CONFLUENCE_DELETED_PAGE_EVENT,
  type ConfluenceReadApi,
  captureConfluenceContent,
  confluenceReadApi,
} from "./sync.js"

/** The Forge webhook event that the Confluence route fans out to sources. */
export const confluenceSourceEventSchema = z.object({
  spaceKeys: z.array(z.string()),
  pageId: z.string().optional(),
  eventType: z.string().optional(),
})
export type ConfluenceSourceEvent = z.infer<typeof confluenceSourceEventSchema>

async function readyClient(orgId: string, connectionId: string) {
  const installation = await getForgeInstallationByConnectionId(
    orgId,
    connectionId,
  )
  if (
    !installation?.cloudId ||
    !installation.appSystemToken ||
    ["revoked", "uninstalled"].includes(installation.status)
  )
    return null
  return {
    client: {
      id: installation.id,
      cloudId: installation.cloudId,
      appSystemToken: installation.appSystemToken,
      atlassianApiBaseUrl: installation.atlassianApiBaseUrl,
    },
    sourceSync: installation.sourceSync ?? { spaces: {}, failures: {} },
  }
}

/**
 * A page or space that fails in this many sync cycles is skipped: the slice
 * is written without it, and the source shows `out_of_access`. Before that,
 * the Workspace keeps its last good copy.
 */
export const CONFLUENCE_SYNC_MAX_TRIES = 3

const failureKey = (error: { spaceKey: string; pageId?: string }) =>
  error.pageId
    ? `page:${error.spaceKey}:${error.pageId}`
    : `space:${error.spaceKey}`

const failureSpace = (key: string) => key.split(":")[1] ?? ""

/** The failures that a scope covers and that reached the try limit. */
function blockingFailures(
  sourceSync: ForgeSourceSync,
  scope: ConfluenceSourceScope,
): string[] {
  return Object.entries(sourceSync.failures).flatMap(([key, failure]) => {
    if (failure.tries < CONFLUENCE_SYNC_MAX_TRIES) return []
    const [kind, spaceKey, pageId] = key.split(":")
    const space = scope.spaces.find((item) => item.key === spaceKey)
    if (!space) return []
    if (
      kind === "page" &&
      space.pages !== "all" &&
      !space.pages.includes(pageId ?? "")
    )
      return []
    return [failure.detail]
  })
}

/**
 * Keep each Confluence read of one sync, so that scopes that share a space
 * fetch each page, attachment list, and asset one time.
 */
function memoizedReads(api: ConfluenceReadApi): ConfluenceReadApi {
  const cache = new Map<string, Promise<unknown>>()
  const memo =
    <A, R>(
      name: string,
      read: (input: A) => Promise<R>,
      key: (input: A) => unknown,
    ) =>
    (input: A): Promise<R> => {
      const cacheKey = `${name}:${JSON.stringify(key(input))}`
      if (!cache.has(cacheKey)) cache.set(cacheKey, read(input))
      return cache.get(cacheKey) as Promise<R>
    }
  return {
    listConfluenceSpaces: memo("spaces", api.listConfluenceSpaces, () => null),
    listConfluencePagesForSpace: memo(
      "pages",
      api.listConfluencePagesForSpace,
      (input) => input.spaceId,
    ),
    getConfluencePageWithBody: memo(
      "page",
      api.getConfluencePageWithBody,
      (input) => input.pageId,
    ),
    listConfluencePageAttachments: memo(
      "attachments",
      api.listConfluencePageAttachments,
      (input) => [input.pageId, input.maxAttachments],
    ),
    downloadConfluenceAttachment: memo(
      "attachment",
      api.downloadConfluenceAttachment,
      (input) => [input.pageId, input.attachmentId],
    ),
    downloadConnectorAsset: memo(
      "asset",
      api.downloadConnectorAsset,
      (input) => [input.url, input.filename],
    ),
  }
}

/**
 * The Confluence adapter of the Workspace sources sync (ADR-050). It reuses
 * the mirror capture and its `confluence/<space>/` layout. The page tree of a
 * page selection decides the file paths, so it returns files for each scope.
 */
export const confluenceSourceAdapter: SourceAdapter<ConfluenceSourceScope> = {
  provider: "confluence",
  managedPaths: (scope) =>
    scope.spaces.map((space) => `confluence/${space.key}/`),
  async fetch({ orgId, connectionId, scopes, countFailures }) {
    const ready = await readyClient(orgId, connectionId)
    if (!ready)
      throw new Error("Forge installation is not ready for Confluence sync")
    const { client, sourceSync } = ready
    const startedAt = new Date().toISOString()
    const api =
      scopes.length > 1 ? memoizedReads(confluenceReadApi()) : undefined
    // A "Sync now" sync keeps each count as it is.
    const tries = (key: string) =>
      (sourceSync.failures[key]?.tries ?? 0) + (countFailures ? 1 : 0)
    const failed = new Map<string, string>()
    const checkedSpaces = new Set<string>()
    const syncedSpaces = new Set<string>()
    const each: Array<GitFileChange[] | null> = []
    for (const scope of scopes) {
      let captured: Awaited<ReturnType<typeof captureConfluenceContent>>
      try {
        captured = await captureConfluenceContent({
          forgeInstallation: client,
          config: {
            spaces: scope.spaces.map((space) => ({
              spaceKey: space.key,
              selectedPageIds: space.pages === "all" ? null : space.pages,
            })),
          },
          existingPaths: [],
          api,
        })
      } catch (error) {
        // A provider outage: this scope keeps its last good copy, uncounted.
        getLogger().warn("Confluence source scope capture failed", {
          step: "confluence.sources.capture",
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        })
        each.push(null)
        continue
      }
      for (const space of scope.spaces) checkedSpaces.add(space.key)
      for (const error of captured.errors) {
        const key = failureKey(error)
        failed.set(
          key,
          `${error.pageId ? `Confluence page ${error.pageId} in space ${error.spaceKey}` : `Confluence space ${error.spaceKey}`} failed ${tries(key)} syncs: ${error.message}`,
        )
      }
      // The frame deletes owned files that are not in the slice. Until a
      // failure reaches the try limit, write nothing, so the last copy stays.
      if (
        captured.errors.some(
          (error) => tries(failureKey(error)) < CONFLUENCE_SYNC_MAX_TRIES,
        )
      ) {
        each.push(null)
        continue
      }
      for (const space of scope.spaces) syncedSpaces.add(space.key)
      each.push(captured.files)
    }
    await saveConnectionSourceSync({
      type: "forge",
      orgId,
      connectionId,
      sourceSync: {
        spaces: {
          ...sourceSync.spaces,
          ...Object.fromEntries(
            [...syncedSpaces].map((key) => [key, { lastSyncedAt: startedAt }]),
          ),
        },
        failures: {
          // Keep the count of a space that this cycle could not check.
          ...Object.fromEntries(
            Object.entries(sourceSync.failures).filter(
              ([key]) => !checkedSpaces.has(failureSpace(key)),
            ),
          ),
          ...Object.fromEntries(
            [...failed]
              .filter(([key]) => tries(key) > 0)
              .map(([key, detail]) => [key, { tries: tries(key), detail }]),
          ),
        },
      },
    })
    return { filesByScope: each }
  },
  async syncStatus({ orgId, connectionId, scope }) {
    const ready = await readyClient(orgId, connectionId)
    const details = ready ? blockingFailures(ready.sourceSync, scope) : []
    return details.length
      ? { status: "out_of_access" as const, detail: details.join("; ") }
      : null
  },
  async checkAccess({ orgId, connectionId, scope }) {
    const ready = await readyClient(orgId, connectionId)
    if (!ready) return "The Confluence connection is not ready"
    const keys = await listConfluenceSpaces(ready.client).then(
      (spaces) => new Set(spaces.map((space) => space.key)),
      () => null,
    )
    // During an outage, a failure that the sync recorded still shows.
    if (!keys)
      return blockingFailures(ready.sourceSync, scope).join("; ") || null
    const missing = scope.spaces.filter((space) => !keys.has(space.key))
    return missing.length
      ? `This Confluence site has no space ${missing.map((space) => space.key).join(", ")}, or ctxpipe cannot read it`
      : null
  },
  matchesEvent: ({ event, scope }) => {
    const parsed = confluenceSourceEventSchema.safeParse(event)
    if (!parsed.success) return true
    const { spaceKeys, pageId, eventType } = parsed.data
    return scope.spaces.some(
      (space) =>
        spaceKeys.includes(space.key) &&
        (space.pages === "all" ||
          !pageId ||
          eventType === CONFLUENCE_DELETED_PAGE_EVENT ||
          space.pages.includes(pageId)),
    )
  },
}
