import { and, desc, eq, sql } from "drizzle-orm"

import {
  type Db,
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { accounts, members } from "../db/schema/auth.js"
import { confluenceSpaces } from "../db/schema/confluenceSpaces.js"
import { CONNECTION_TYPE_FORGE, connections } from "../db/schema/connections.js"
import {
  type ForgeConnectionConfig,
  parseForgeConnectionConfig,
  serialiseForgeConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  deleteConnectionDirectory,
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
async function listForgeConnectionsForOrg(
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

type ResolveForgeInstallationResult =
  | { status: "ok"; installation: ForgeInstallationShape }
  | { status: "none" }
  | { status: "ambiguous" }

async function resolveForgeInstallationForOrgDetailed(
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
    const merged = { ...cur, ...patch }
    const next = serialiseForgeConnectionConfigForDb({
      ...merged,
      atlassianOAuthClientId: merged.atlassianOAuthClientId,
      atlassianOAuthClientSecret: merged.atlassianOAuthClientSecret,
    })
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

/**
 * True for a pending Forge draft that only "Add Confluence" created: no
 * Atlassian app, no site, no provisioning, no opened install and no install.
 * The Atlassian account link belongs to the user, not to the draft, so it
 * does not count.
 */
function isEmptyForgeSetupDraft(config: ForgeConnectionConfig): boolean {
  return (
    config.status === "pending" &&
    config.provisionStatus === "idle" &&
    !config.cloudId &&
    !config.installationId &&
    !config.installationContext &&
    !config.appId &&
    !config.appSystemToken &&
    !config.atlassianOAuthClientId &&
    !config.atlassianOAuthClientSecret &&
    !config.confluenceSiteHost &&
    !config.confluenceForgeInstallUrl &&
    !config.forgeScopedApiToken &&
    !config.forgeOperatorEmail &&
    !config.provisionWorkflowRunId &&
    !config.lastProvisionAt &&
    !config.sourceSync &&
    !config.installOpenedAt
  )
}

/**
 * Cancel a Forge setup: delete the draft while it is still empty. Returns
 * true when no draft is left, also when it was already gone. Returns false
 * and keeps a draft with progress, so the user can finish or remove it. The
 * row lock orders the delete with a concurrent write, such as the install
 * event or a credential save.
 */
export async function cancelForgeSetupDraft(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const outcome = await withOrgDbContext(orgId, async (db) => {
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
      .for("update")
      .limit(1)
    if (!row) return "gone"
    const config = parseForgeConnectionConfig(
      row.config as Record<string, unknown>,
    )
    if (!isEmptyForgeSetupDraft(config)) return "kept"
    await db.delete(connections).where(eq(connections.id, connectionId))
    return "deleted"
  })
  if (outcome === "deleted") await deleteConnectionDirectory(connectionId)
  return outcome !== "kept"
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
  /**
   * The user opened the Forge install. The install event can bind to this
   * draft, so a cancel keeps it.
   */
  installOpened?: boolean
}): Promise<ForgeInstallationShape> {
  const installOpenedAt = input.installOpened
    ? new Date().toISOString()
    : undefined
  const row = await withOrgDbContext(input.orgId, async () => {
    const db = getOrgDb()
    // The row lock orders the mark with a concurrent cancel.
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
      .for("update")
      .limit(1)
    // Reuse the draft as it is: it can hold a saved OAuth app or site host.
    if (existing && !installOpenedAt) return existing
    if (existing) {
      const [marked] = await db
        .update(connections)
        .set({
          config: {
            ...(existing.config as Record<string, unknown>),
            installOpenedAt,
          },
          updatedAt: new Date(),
        })
        .where(eq(connections.id, existing.id))
        .returning()
      return marked ?? existing
    }

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
      sourceSync: null,
    })

    const id = generateObjectId("con")
    const [created] = await db
      .insert(connections)
      .values({
        id,
        orgId: input.orgId,
        type: CONNECTION_TYPE_FORGE,
        config: { ...pendingConfig, installOpenedAt },
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
        sourceSync: prior?.sourceSync ?? null,
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
        .set({
          config: mergedConfig,
          updatedAt: new Date(),
          contentSyncGeneration: sql`case when ${connections.config}->>'cloudId' is distinct from ${mergedConfig.cloudId ?? null}::text
            or ${connections.config}->>'atlassianApiBaseUrl' is distinct from ${mergedConfig.atlassianApiBaseUrl ?? null}::text
            then ${connections.contentSyncGeneration} + 1 else ${connections.contentSyncGeneration} end`,
        })
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
