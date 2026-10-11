import { z } from "zod"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import type { ConfluenceSourceScope } from "../../domain/workspace-sources/providers/confluence.js"
import {
  getForgeInstallationByConnectionId,
  recordConfluenceSpacesSynced,
} from "../../models/atlassian-connector.js"
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
    id: installation.id,
    cloudId: installation.cloudId,
    appSystemToken: installation.appSystemToken,
    atlassianApiBaseUrl: installation.atlassianApiBaseUrl,
  }
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
  async fetchEach({ orgId, connectionId, scopes }) {
    const client = await readyClient(orgId, connectionId)
    if (!client)
      throw new Error("Forge installation is not ready for Confluence sync")
    const startedAt = new Date()
    const api =
      scopes.length > 1 ? memoizedReads(confluenceReadApi()) : undefined
    const each: GitFileChange[][] = []
    for (const scope of scopes) {
      const captured = await captureConfluenceContent({
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
      // The frame deletes owned files that are not in the slice. Write nothing
      // after a failed page, so that its last good copy stays.
      if (captured.pagesFailed > 0)
        throw new Error(
          `Confluence sync failed for ${captured.pagesFailed} page(s): ${captured.errors
            .slice(0, 3)
            .map((error) =>
              `${error.spaceKey} ${error.pageId ?? ""} ${error.message}`.trim(),
            )
            .join("; ")}`,
        )
      each.push(captured.files)
    }
    await recordConfluenceSpacesSynced({
      orgId,
      connectionId,
      spaceKeys: [
        ...new Set(scopes.flatMap((scope) => scope.spaces.map((s) => s.key))),
      ],
      lastSyncedAt: startedAt,
    })
    return each
  },
  async checkAccess({ orgId, connectionId, scope }) {
    const client = await readyClient(orgId, connectionId)
    if (!client) return "The Confluence connection is not ready"
    const keys = await listConfluenceSpaces(client).then(
      (spaces) => new Set(spaces.map((space) => space.key)),
      // A provider outage must not mark the source out of access.
      () => null,
    )
    if (!keys) return null
    const missing = scope.spaces.filter((space) => !keys.has(space.key))
    return missing.length
      ? `This Confluence site has no space ${missing.map((space) => space.key).join(", ")}, or ctx| cannot read it`
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
