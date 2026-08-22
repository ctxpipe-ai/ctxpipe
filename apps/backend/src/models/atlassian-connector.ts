import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import {
  type Db,
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { accounts, members, organizations } from "../db/schema/auth.js"
import { confluenceSpaces } from "../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { CONNECTION_TYPE_FORGE, connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type ForgeConnectionConfig,
  parseForgeConnectionConfig,
  serialiseForgeConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  deleteConnectionDirectory,
  listConnectionDirectoryByForgeCloudId,
  listConnectionDirectoryByForgeInstallationId,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import {
  type ConnectionRow,
  type ForgeInstallationShape,
  forgeConnectionToShape,
  forgeShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

/** @deprecated Use `ForgeInstallationShape` — kept as alias for existing imports. */
export type ForgeInstallation = ForgeInstallationShape
export type ConfluenceSpaceSelection = typeof confluenceSpaces.$inferSelect

function forgeConfigCloudIdRef() {
  return sql<string>`${connections.config}->>'cloudId'`
}

function forgeConfigStatusRef() {
  return sql<string>`${connections.config}->>'status'`
}

function forgeConfigInstalledByUserIdRef() {
  return sql<string>`${connections.config}->>'installedByUserId'`
}

const FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX =
  "ari:cloud:ecosystem::installation/"

function normalizeForgeInstallationIdForLookup(
  raw: string,
): string | undefined {
  const t = raw.trim()
  if (!t) return undefined
  return t.replace(FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX, "")
}

/** Must run inside {@link withOrgDbContext} (e.g. org-scoped API routes). */
export async function getAtlassianUserAccessToken(
  userId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ accessToken: accounts.accessToken })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.providerId, "atlassian")),
    )
    .limit(1)
  return row?.accessToken ?? undefined
}

/**
 * Forge `cloudId` is per Confluence site; multiple ctxpipe orgs can reference the same site.
 * Callers must scope by {@link orgId} so lifecycle and other flows never pair the wrong tenant.
 */
export async function getForgeInstallationByCloudId(
  cloudId: string,
  orgId: string,
): Promise<ForgeInstallationShape | undefined> {
  return withOrgDbContext(orgId, async () => {
    const [row] = await getOrgDb()
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.type, CONNECTION_TYPE_FORGE),
          eq(connections.orgId, orgId),
          eq(forgeConfigCloudIdRef(), cloudId),
        ),
      )
      .limit(1)
    return row ? forgeConnectionToShape(row) : undefined
  })
}

/** Resolve by Forge ecosystem installation id (bare UUID or full ARI). */
export async function getForgeInstallationByForgeInstallationId(
  installationId: string,
): Promise<ForgeInstallationShape | undefined> {
  const bare = normalizeForgeInstallationIdForLookup(installationId)
  if (!bare) return undefined
  const directoryRows = [
    ...(await listConnectionDirectoryByForgeInstallationId(bare)),
    ...(await listConnectionDirectoryByForgeInstallationId(
      `${FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX}${bare}`,
    )),
  ]
  for (const directoryRow of directoryRows) {
    const row = await loadConnectionViaDirectory(directoryRow.connectionId)
    if (row?.type === CONNECTION_TYPE_FORGE) return forgeConnectionToShape(row)
  }
  return undefined
}

/** Must run inside {@link withOrgDbContext} when `orgId` is known. */
export async function listForgeConnectionsForOrg(
  orgId: string,
): Promise<ForgeInstallationShape[]> {
  return withOrgDbContext(orgId, async () => {
    const rows = await getOrgDb()
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .orderBy(desc(connections.updatedAt))
    return rows.map(forgeConnectionToShape)
  })
}

/**
 * @deprecated Prefer `listForgeConnectionsForOrg` or `resolveForgeInstallationForOrg`.
 */
export async function getForgeInstallationByOrgId(
  orgId: string,
): Promise<ForgeInstallationShape | undefined> {
  const list = await listForgeConnectionsForOrg(orgId)
  return list[0]
}

export const MULTIPLE_FORGE_CONNECTIONS_MESSAGE =
  "Multiple Confluence/Forge connections for this organization; specify connectionId query parameter"

export type ResolveForgeInstallationResult =
  | { status: "ok"; installation: ForgeInstallationShape }
  | { status: "none" }
  | { status: "ambiguous" }

export async function resolveForgeInstallationForOrgDetailed(
  orgId: string,
  connectionId?: string | null,
): Promise<ResolveForgeInstallationResult> {
  if (connectionId) {
    const installation = await getForgeInstallationByConnectionId(
      orgId,
      connectionId,
    )
    return installation ? { status: "ok", installation } : { status: "none" }
  }
  const list = await listForgeConnectionsForOrg(orgId)
  if (list.length === 0) return { status: "none" }
  if (list.length === 1) return { status: "ok", installation: list[0]! }
  return { status: "ambiguous" }
}

/**
 * Load a Forge installation row for the org connection.
 * Opens a short org transaction when `orgDb` is omitted. Pass `orgDb` from an
 * already-open {@link withOrgDbContext} in workers where ALS may not propagate.
 */
export async function getForgeInstallationByConnectionId(
  orgId: string,
  connectionId: string,
  orgDb?: Db,
): Promise<ForgeInstallationShape | undefined> {
  const load = async (db: Db) => {
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .limit(1)
    return row ? forgeConnectionToShape(row) : undefined
  }
  if (orgDb) return load(orgDb)
  return withOrgDbContext(orgId, load)
}

/** Merge a partial typed `connections.config` slice for a forge row (e.g. provision progress). */
export async function patchForgeConnectionTypedConfig(
  orgId: string,
  connectionId: string,
  patch: Partial<ForgeConnectionConfig>,
): Promise<ForgeInstallationShape | undefined> {
  const updated = await withOrgDbContext(orgId, async (db) => {
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .limit(1)
    if (!row) return undefined
    const cur = parseForgeConnectionConfig(
      row.config as Record<string, unknown>,
    )
    const next = serialiseForgeConnectionConfigForDb({ ...cur, ...patch })
    const [out] = await db
      .update(connections)
      .set({ config: next as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(connections.id, connectionId))
      .returning()
    return out
  })
  if (!updated) return undefined
  await upsertConnectionDirectory(updated)
  return forgeConnectionToShape(updated)
}

/** Explicit `connectionId` or the only forge row when exactly one. */
export async function resolveForgeInstallationForOrg(
  orgId: string,
  connectionId?: string | null,
): Promise<ForgeInstallationShape | undefined> {
  const r = await resolveForgeInstallationForOrgDetailed(orgId, connectionId)
  return r.status === "ok" ? r.installation : undefined
}

/** Must run inside {@link withOrgDbContext} for the given `orgId`. */
export async function deleteForgeConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const removed = await withOrgDbContext(orgId, () =>
    getOrgDb()
      .delete(connections)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .returning({ id: connections.id }),
  )
  if (removed.length > 0) await deleteConnectionDirectory(connectionId)
  return removed.length > 0
}

/** Removes all forge connections for the org (cascades spaces and sync targets). */
export async function deleteForgeInstallationByOrgId(
  orgId: string,
): Promise<boolean> {
  const removed = await withOrgDbContext(orgId, () =>
    getOrgDb()
      .delete(connections)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .returning({ id: connections.id }),
  )
  await Promise.all(removed.map((row) => deleteConnectionDirectory(row.id)))
  return removed.length > 0
}

/**
 * Resolves the connection by Forge `installationId` without org in the request (webhook), then
 * applies the update under {@link withOrgDbContext} for that row's `orgId`.
 */
export async function updateForgeAppSystemTokenByInstallationId(input: {
  installationId: string
  appSystemToken: string
  atlassianApiBaseUrl?: string
}): Promise<boolean> {
  const directoryRows = await listConnectionDirectoryByForgeInstallationId(
    input.installationId,
  )
  let row: ConnectionRow | undefined
  for (const directoryRow of directoryRows) {
    const candidate = await loadConnectionViaDirectory(
      directoryRow.connectionId,
    )
    if (candidate?.type === CONNECTION_TYPE_FORGE) {
      row = candidate
      break
    }
  }
  if (!row) return false

  const updated = await withOrgDbContext(row.orgId, async () => {
    const db = getOrgDb()
    const shape = forgeConnectionToShape(row)
    const nextConfig = forgeShapeToConfig(
      {
        ...shape,
        appSystemToken: input.appSystemToken,
        atlassianApiBaseUrl:
          input.atlassianApiBaseUrl ?? shape.atlassianApiBaseUrl,
      },
      {
        preserveOauthClientSecretFromConfig: row.config as Record<
          string,
          unknown
        >,
      },
    )
    const [result] = await db
      .update(connections)
      .set({ config: nextConfig, updatedAt: new Date() })
      .where(eq(connections.id, row.id))
      .returning()
    return result
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

export async function getPendingForgeInstallationForUserInOtherOrg(input: {
  userId: string
  orgId: string
}): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const orgRows = await db
    .select({ orgId: members.organizationId })
    .from(members)
    .where(eq(members.userId, input.userId))
  for (const { orgId } of orgRows) {
    if (orgId === input.orgId) continue
    const installation = await withOrgDbContext(orgId, async () => {
      const [row] = await getOrgDb()
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.orgId, orgId),
            eq(connections.type, CONNECTION_TYPE_FORGE),
            eq(forgeConfigStatusRef(), "pending"),
            eq(forgeConfigInstalledByUserIdRef(), input.userId),
          ),
        )
        .orderBy(desc(connections.updatedAt))
        .limit(1)
      return row ? forgeConnectionToShape(row) : undefined
    })
    if (installation) return installation
  }
  return undefined
}

export async function upsertPendingForgeInstallation(input: {
  orgId: string
  installedByUserId: string
}): Promise<ForgeInstallationShape> {
  const row = await withOrgDbContext(input.orgId, async () => {
    const db = getOrgDb()
    const [existing] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
          eq(forgeConfigStatusRef(), "pending"),
          eq(forgeConfigInstalledByUserIdRef(), input.installedByUserId),
        ),
      )
      .orderBy(desc(connections.updatedAt))
      .limit(1)

    const pendingConfig = forgeShapeToConfig({
      cloudId: null,
      installationContext: null,
      installationId: null,
      appId: null,
      appSystemToken: null,
      atlassianApiBaseUrl: null,
      installedByUserId: input.installedByUserId,
      status: "pending",
      lastEventPayload: null,
      confluenceSiteHost: null,
      confluenceForgeInstallUrl: null,
      forgeScopedApiToken: null,
      forgeOperatorEmail: null,
      provisionStatus: "idle",
      provisionErrorCode: null,
      provisionStderr: null,
      provisionWorkflowRunId: null,
      lastProvisionAt: null,
      atlassianOAuthClientId: null,
    })

    if (existing) {
      const [updated] = await db
        .update(connections)
        .set({ config: pendingConfig, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
      if (!updated)
        throw new Error("Failed to upsert pending forge installation")
      return updated
    }

    const id = generateObjectId("con")
    const [created] = await db
      .insert(connections)
      .values({
        id,
        orgId: input.orgId,
        type: CONNECTION_TYPE_FORGE,
        config: pendingConfig,
      })
      .returning()
    if (!created) throw new Error("Failed to upsert pending forge installation")
    return created
  })
  await upsertConnectionDirectory(row)
  return forgeConnectionToShape(row)
}

export async function getPendingForgeInstallationByInstallerAccountId(
  installerAccountId: string,
): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const [account] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.providerId, "atlassian"),
        eq(accounts.accountId, installerAccountId),
      ),
    )
    .limit(1)
  if (!account) return undefined
  const orgRows = await db
    .select({ orgId: members.organizationId })
    .from(members)
    .where(eq(members.userId, account.userId))
  for (const { orgId } of orgRows) {
    const installation = await withOrgDbContext(orgId, async () => {
      const [row] = await getOrgDb()
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.orgId, orgId),
            eq(connections.type, CONNECTION_TYPE_FORGE),
            eq(forgeConfigStatusRef(), "pending"),
            eq(forgeConfigInstalledByUserIdRef(), account.userId),
          ),
        )
        .orderBy(desc(connections.updatedAt))
        .limit(1)
      return row ? forgeConnectionToShape(row) : undefined
    })
    if (installation) return installation
  }
  return undefined
}

/**
 * Webhooks resolve `orgId` from installation rows first; this runs the write under
 * {@link withOrgDbContext} for that org.
 */
export async function upsertForgeInstallationFromEvent(input: {
  orgId: string
  cloudId: string
  status: string
  installationContext?: string | null
  installationId?: string | null
  appId?: string | null
  appSystemToken?: string | null
  atlassianApiBaseUrl?: string
  installedByUserId?: string | null
  lastEventPayload?: unknown
  /**
   * When set, update this connection row (e.g. pending install before `cloudId` exists in config).
   * Without this, lookup is only by `orgId` + `cloudId`, so pending rows with `cloudId: null` get
   * a duplicate insert on first lifecycle webhook.
   */
  connectionId?: string | null
}): Promise<ForgeInstallationShape> {
  const row = await withOrgDbContext(input.orgId, async () => {
    const db = getOrgDb()
    type ConnRow = typeof connections.$inferSelect
    let existing: ConnRow | undefined

    if (input.connectionId) {
      const [byId] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, input.connectionId),
            eq(connections.orgId, input.orgId),
            eq(connections.type, CONNECTION_TYPE_FORGE),
          ),
        )
        .limit(1)
      existing = byId
    }
    if (!existing) {
      const [byCloud] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.orgId, input.orgId),
            eq(connections.type, CONNECTION_TYPE_FORGE),
            eq(forgeConfigCloudIdRef(), input.cloudId),
          ),
        )
        .limit(1)
      existing = byCloud
    }

    const prior = existing ? forgeConnectionToShape(existing) : undefined
    const installedByUserId =
      input.installedByUserId !== undefined
        ? input.installedByUserId
        : (prior?.installedByUserId ?? null)

    const mergedConfig = forgeShapeToConfig(
      {
        cloudId: input.cloudId,
        installationContext:
          input.installationContext ?? prior?.installationContext ?? null,
        installationId: input.installationId ?? prior?.installationId ?? null,
        appId: input.appId ?? prior?.appId ?? null,
        appSystemToken: input.appSystemToken ?? prior?.appSystemToken ?? null,
        atlassianApiBaseUrl:
          input.atlassianApiBaseUrl ?? prior?.atlassianApiBaseUrl ?? null,
        installedByUserId,
        status: input.status,
        lastEventPayload:
          input.lastEventPayload ?? prior?.lastEventPayload ?? null,
        confluenceSiteHost: prior?.confluenceSiteHost ?? null,
        confluenceForgeInstallUrl: prior?.confluenceForgeInstallUrl ?? null,
        forgeScopedApiToken: prior?.forgeScopedApiToken ?? null,
        forgeOperatorEmail: prior?.forgeOperatorEmail ?? null,
        provisionStatus: prior?.provisionStatus ?? "idle",
        provisionErrorCode: prior?.provisionErrorCode ?? null,
        provisionStderr: prior?.provisionStderr ?? null,
        provisionWorkflowRunId: prior?.provisionWorkflowRunId ?? null,
        lastProvisionAt: prior?.lastProvisionAt ?? null,
        atlassianOAuthClientId: prior?.atlassianOAuthClientId ?? null,
      },
      existing
        ? {
            preserveOauthClientSecretFromConfig: existing.config as Record<
              string,
              unknown
            >,
          }
        : undefined,
    )

    if (existing) {
      const [row] = await db
        .update(connections)
        .set({ config: mergedConfig, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
      if (!row) throw new Error("Failed to upsert forge installation")
      return row
    }

    const id = generateObjectId("con")
    const [created] = await db
      .insert(connections)
      .values({
        id,
        orgId: input.orgId,
        type: CONNECTION_TYPE_FORGE,
        config: mergedConfig,
      })
      .returning()
    if (!created) throw new Error("Failed to upsert forge installation")
    return created
  })
  await upsertConnectionDirectory(row)
  return forgeConnectionToShape(row)
}

export async function getOrganizationSlugForCloudIdByUser(
  userId: string,
  cloudId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const directoryRows = await listConnectionDirectoryByForgeCloudId(cloudId)
  const orgIds = [...new Set(directoryRows.map((row) => row.orgId))]
  if (orgIds.length === 0) return undefined
  const [row] = await db
    .select({ orgSlug: organizations.slug })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(
      and(eq(members.userId, userId), inArray(members.organizationId, orgIds)),
    )
    .limit(1)
  return row?.orgSlug
}

export async function listConfluenceSpacesByConnectionId(
  connectionId: string,
): Promise<ConfluenceSpaceSelection[]> {
  return withAmbientOrgDb(async () => {
    const db = getOrgDb()
    return db
      .select()
      .from(confluenceSpaces)
      .where(eq(confluenceSpaces.connectionId, connectionId))
  })
}

export async function replaceConfluenceSpacesForConnection(input: {
  connectionId: string
  spaces: Array<{
    spaceKey: string
    spaceName?: string
    selectedPageIds?: string[] | null
  }>
}): Promise<ConfluenceSpaceSelection[]> {
  return withAmbientOrgDb(async () => {
    const db = getOrgDb()
    return db.transaction(async (tx) => {
      await tx
        .delete(confluenceSpaces)
        .where(eq(confluenceSpaces.connectionId, input.connectionId))

      if (input.spaces.length === 0) {
        return []
      }

      return tx
        .insert(confluenceSpaces)
        .values(
          input.spaces.map((space) => ({
            id: generateObjectId("csp"),
            orgId: requireCurrentOrgId(),
            connectionId: input.connectionId,
            spaceKey: space.spaceKey,
            spaceName: space.spaceName ?? null,
            selectedPageIds: space.selectedPageIds ?? null,
          })),
        )
        .returning()
    })
  })
}

export async function updateConfluenceSpaceSyncState(input: {
  connectionId: string
  spaceKey: string
  lastSyncedAt: Date
  lastSyncedPageId?: string | null
}): Promise<void> {
  await withAmbientOrgDb(async () => {
    const db = getOrgDb()
    await db
      .update(confluenceSpaces)
      .set({
        lastSyncedAt: input.lastSyncedAt,
        lastSyncedPageId: input.lastSyncedPageId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(confluenceSpaces.connectionId, input.connectionId),
          eq(confluenceSpaces.spaceKey, input.spaceKey),
        ),
      )
  })
}

type SyncTargetPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  branch: string
  enabled: boolean
}

async function resolveRepositoryIdForConfluenceSync(
  tx: Db,
  orgId: string,
  sync: SyncTargetPatchInput,
  defaultGithubConnectionId: string | undefined,
): Promise<{ repositoryId: string; didCreate: boolean }> {
  if (sync.repositoryId) {
    const [byId] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, sync.repositoryId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (byId) return { repositoryId: byId.id, didCreate: false }
  }
  const gitUrl = sync.gitUrl
  const name = sync.repositoryName
  if (!gitUrl || !name) {
    throw new Error("Repository not found for organization")
  }

  const [byUrl] = await tx
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.gitUrl, gitUrl)))
    .limit(1)
  if (byUrl) return { repositoryId: byUrl.id, didCreate: false }

  const id = generateObjectId("repo")
  const checkoutId = generateObjectId("co")
  const [created] = await tx
    .insert(repositories)
    .values({
      id,
      orgId,
      name,
      gitUrl,
      githubConnectionId: defaultGithubConnectionId ?? null,
    })
    .returning()
  if (!created) throw new Error("Failed to create repository")

  const [checkout] = await tx
    .insert(repositoryCheckouts)
    .values({
      id: checkoutId,
      orgId,
      repositoryId: id,
      ref: "main",
      checkoutKey: DEFAULT_CHECKOUT_KEY,
    })
    .returning({ id: repositoryCheckouts.id })
  if (!checkout) {
    throw new Error("Failed to create repository checkout")
  }

  return { repositoryId: id, didCreate: true }
}

/** PATCH semantics: omit `spaces` or `syncTarget` to leave that part unchanged. */
export async function patchAtlassianConnectorConfig(input: {
  orgId: string
  connectionId: string
  spaces?: Array<{
    spaceKey: string
    spaceName?: string
    selectedPageIds?: string[] | null
  }>
  syncTarget?: SyncTargetPatchInput
}): Promise<{
  spaces: ConfluenceSpaceSelection[]
  /** When a new `repositories` row was inserted for the sync target, enqueue ingestion from the route. */
  repositoryIngestion?: { orgId: string; repositoryId: string }
}> {
  const defaultGithubConnectionId = (
    await listGithubConnectionsForOrg(input.orgId)
  )[0]?.id

  return withOrgDbContext(input.orgId, async () => {
    const db = getOrgDb()
    return db.transaction(async (tx) => {
      let repositoryIngestion:
        | { orgId: string; repositoryId: string }
        | undefined
      if (input.spaces !== undefined) {
        await tx
          .delete(confluenceSpaces)
          .where(eq(confluenceSpaces.connectionId, input.connectionId))

        if (input.spaces.length > 0) {
          await tx.insert(confluenceSpaces).values(
            input.spaces.map((space) => ({
              id: generateObjectId("csp"),
              orgId: input.orgId,
              connectionId: input.connectionId,
              spaceKey: space.spaceKey,
              spaceName: space.spaceName ?? null,
              selectedPageIds: space.selectedPageIds ?? null,
            })),
          )
        }
      }

      if (input.syncTarget !== undefined) {
        const { repositoryId, didCreate } =
          await resolveRepositoryIdForConfluenceSync(
            tx,
            input.orgId,
            input.syncTarget,
            defaultGithubConnectionId,
          )
        if (didCreate) {
          repositoryIngestion = {
            orgId: input.orgId,
            repositoryId,
          }
        }

        const [row] = await tx
          .insert(confluenceSyncTargets)
          .values({
            id: generateObjectId("cst"),
            orgId: input.orgId,
            connectionId: input.connectionId,
            repositoryId,
            branch: input.syncTarget.branch,
            enabled: input.syncTarget.enabled,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
          })
          .onConflictDoUpdate({
            target: confluenceSyncTargets.connectionId,
            set: {
              repositoryId,
              branch: input.syncTarget.branch,
              enabled: input.syncTarget.enabled,
              updatedAt: new Date(),
            },
          })
          .returning()

        if (!row) {
          throw new Error("Failed to save Confluence sync target")
        }
      }

      const spaces = await tx
        .select()
        .from(confluenceSpaces)
        .where(eq(confluenceSpaces.connectionId, input.connectionId))

      return { spaces, repositoryIngestion }
    })
  })
}
