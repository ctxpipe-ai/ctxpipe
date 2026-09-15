import { and, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { type Db, getOrgDb, getSystemDb } from "../db/client.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  encodePagerdutyWebhookSecretForDb,
  type PagerdutySetupPhase,
  parsePagerdutyConnectionStored,
  serialisePagerdutyConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  type ConnectionRow,
  type PagerdutyConnectionShape,
  pagerdutyConnectionToShape,
  pagerdutyShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type { PagerdutySetupPhase } from "../lib/connection-config.js"

export type PagerdutyConnection = PagerdutyConnectionShape

export type PagerdutyBinding = {
  id: string
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  enabled: boolean
  setupPhase: PagerdutySetupPhase
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  createdAt: Date
  updatedAt: Date
}

export type PagerdutyBindingWithRepo = PagerdutyBinding & {
  repositoryName: string
  githubConnectionId: string | null
}

function bindingFromConnectionRow(
  row: ConnectionRow,
): PagerdutyBinding | undefined {
  const config = parsePagerdutyConnectionStored(
    row.config as Record<string, unknown>,
  )
  if (!config.repositoryId || !config.branch) return undefined
  return {
    id: row.id,
    orgId: row.orgId,
    connectionId: row.id,
    repositoryId: config.repositoryId,
    branch: config.branch,
    enabled: config.enabled,
    setupPhase: config.setupPhase,
    pendingConfigPullUrl: config.pendingConfigPullUrl,
    pendingConfigPrCreating: config.pendingConfigPrCreating,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mergePagerdutyStoredConfig(
  row: ConnectionRow,
  patch: Partial<{
    repositoryId: string | null
    branch: string | null
    enabled: boolean
    setupPhase: PagerdutySetupPhase
    pendingConfigPullUrl: string | null
    pendingConfigPrCreating: boolean
    webhookSubscriptionId: string | null
    webhookSecretEnc: string | undefined
  }>,
): Record<string, unknown> {
  const stored = parsePagerdutyConnectionStored(
    row.config as Record<string, unknown>,
  )
  return serialisePagerdutyConnectionConfigForDb({
    ...stored,
    ...patch,
  })
}

export function planPagerdutySyncBindingUpdate(input: {
  existing: PagerdutyBinding | undefined
  repositoryId: string
  branch: string
  enabled: boolean
}): {
  changed: boolean
  repositoryOrBranchChanged: boolean
  resetLifecycle: boolean
} {
  const repositoryOrBranchChanged =
    !input.existing ||
    input.existing.repositoryId !== input.repositoryId ||
    input.existing.branch !== input.branch
  const changed =
    repositoryOrBranchChanged ||
    (input.existing?.enabled ?? true) !== input.enabled
  const resetLifecycle = !input.existing || repositoryOrBranchChanged
  return { changed, repositoryOrBranchChanged, resetLifecycle }
}

function pagerdutyConfigAccountIdRef() {
  return sql<string>`${connections.config}->>'accountId'`
}

function pagerdutyConfigWebhookSubscriptionIdRef() {
  return sql<string>`${connections.config}->>'webhookSubscriptionId'`
}

export async function listPagerdutyConnectionsForOrg(
  orgId: string,
  env: Env,
): Promise<PagerdutyConnection[]> {
  const db = getOrgDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
      ),
    )
    .orderBy(desc(connections.updatedAt))
  return rows.map((row) => pagerdutyConnectionToShape(row, env))
}

export async function getPagerdutyConnectionByConnectionId(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<PagerdutyConnection | undefined> {
  const db = getOrgDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
      ),
    )
    .limit(1)
  return row ? pagerdutyConnectionToShape(row, env) : undefined
}

export const MULTIPLE_PAGERDUTY_CONNECTIONS_MESSAGE =
  "Multiple PagerDuty connections for this organization; specify connectionId query parameter"

export type ResolvePagerdutyConnectionResult =
  | { status: "ok"; connection: PagerdutyConnection }
  | { status: "none" }
  | { status: "ambiguous" }

export async function resolvePagerdutyConnectionForOrgDetailed(
  orgId: string,
  env: Env,
  connectionId?: string | null,
): Promise<ResolvePagerdutyConnectionResult> {
  if (connectionId) {
    const connection = await getPagerdutyConnectionByConnectionId(
      orgId,
      connectionId,
      env,
    )
    return connection ? { status: "ok", connection } : { status: "none" }
  }
  const list = await listPagerdutyConnectionsForOrg(orgId, env)
  if (list.length === 0) return { status: "none" }
  const [connection] = list
  if (list.length === 1 && connection) {
    return { status: "ok", connection }
  }
  return { status: "ambiguous" }
}

export async function upsertPagerdutyConnectionFromOAuth(input: {
  orgId: string
  env: Env
  ownerUserId: string
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
  accountId: string
  accountName: string
  accountSubdomain: string
  region: "us" | "eu"
  actorUserId: string | null
}): Promise<PagerdutyConnection> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${input.accountId}`}, 0))`,
    )
    const [matched] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
          eq(pagerdutyConfigAccountIdRef(), input.accountId),
        ),
      )
      .orderBy(desc(connections.updatedAt))
      .limit(1)
    let existing = matched
    if (existing) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${existing.id}, 0))`,
      )
      const [latestExisting] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, existing.id),
            eq(connections.orgId, input.orgId),
            eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
          ),
        )
        .limit(1)
      existing = latestExisting
    }

    const existingShape = existing
      ? pagerdutyConnectionToShape(existing, input.env)
      : undefined
    const config = pagerdutyShapeToConfig(
      {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        accountId: input.accountId,
        accountName: input.accountName,
        accountSubdomain: input.accountSubdomain,
        region: input.region,
        actorUserId: input.actorUserId,
        ownerUserId: input.ownerUserId,
        status: "installed",
        repositoryId: existingShape?.repositoryId ?? null,
        branch: existingShape?.branch ?? null,
        enabled: existingShape?.enabled ?? true,
        setupPhase: existingShape?.setupPhase ?? "draft",
        pendingConfigPullUrl: existingShape?.pendingConfigPullUrl ?? null,
        pendingConfigPrCreating:
          existingShape?.pendingConfigPrCreating ?? false,
        webhookSubscriptionId: existingShape?.webhookSubscriptionId ?? null,
        webhookSecretEnc: existingShape?.webhookSecretEnc ?? null,
      },
      input.env,
    )

    if (existing) {
      const [row] = await tx
        .update(connections)
        .set({ config, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
      if (!row) throw new Error("Failed to update PagerDuty connection")
      return pagerdutyConnectionToShape(row, input.env)
    }

    const [row] = await tx
      .insert(connections)
      .values({
        id: generateObjectId("con"),
        orgId: input.orgId,
        type: CONNECTION_TYPE_PAGERDUTY,
        config,
      })
      .returning()
    if (!row) throw new Error("Failed to create PagerDuty connection")
    return pagerdutyConnectionToShape(row, input.env)
  })
}

export async function savePagerdutyWebhookSubscription(input: {
  orgId: string
  connectionId: string
  env: Env
  webhookSubscriptionId: string
  webhookSecret: string
}): Promise<void> {
  const db = getOrgDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    if (!row) throw new Error("PagerDuty connection not found")
    await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          webhookSubscriptionId: input.webhookSubscriptionId,
          webhookSecretEnc: encodePagerdutyWebhookSecretForDb(
            input.webhookSecret,
            input.env,
          ),
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function refreshPagerdutyConnectionTokensWithLock(input: {
  orgId: string
  connectionId: string
  env: Env
  expectedRefreshToken: string
  expectedAccessToken: string
  refresh: (refreshToken: string) => Promise<{
    accessToken: string
    refreshToken: string | null
    accessTokenExpiresAt?: string | null
  }>
}): Promise<{
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    if (!row) throw new Error("PagerDuty connection not found")
    const current = pagerdutyConnectionToShape(row, input.env)
    if (
      current.accessToken !== input.expectedAccessToken ||
      current.refreshToken !== input.expectedRefreshToken
    ) {
      return {
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        accessTokenExpiresAt: current.accessTokenExpiresAt,
      }
    }
    if (!current.refreshToken) {
      throw new Error("PagerDuty connection has no refresh token")
    }
    const refreshed = await input.refresh(current.refreshToken)
    const tokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      accessTokenExpiresAt:
        refreshed.accessTokenExpiresAt ?? current.accessTokenExpiresAt,
    }
    const config = pagerdutyShapeToConfig(
      {
        ...current,
        ...tokens,
      },
      input.env,
    )
    const [updated] = await tx
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .returning({ id: connections.id })
    if (!updated) {
      throw new Error("PagerDuty connection was removed during token refresh")
    }
    return tokens
  })
}

export async function listPagerdutyConnectionsByWebhookSubscriptionId(input: {
  webhookSubscriptionId: string
  env: Env
}): Promise<PagerdutyConnection[]> {
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        eq(
          pagerdutyConfigWebhookSubscriptionIdRef(),
          input.webhookSubscriptionId,
        ),
      ),
    )
  return rows.map((row) => pagerdutyConnectionToShape(row, input.env))
}

export async function deletePagerdutyConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const db = getOrgDb()
  const removed = await db
    .delete(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
      ),
    )
    .returning({ id: connections.id })
  return removed.length > 0
}

export async function getPagerdutyBindingByConnectionId(
  connectionId: string,
): Promise<PagerdutyBinding | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
      ),
    )
    .limit(1)
  return row ? bindingFromConnectionRow(row) : undefined
}

export async function getPagerdutyBindingWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<PagerdutyBindingWithRepo | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({
      connection: connections,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(connections)
    .innerJoin(
      repositories,
      and(
        eq(repositories.orgId, connections.orgId),
        eq(repositories.id, sql`${connections.config}->>'repositoryId'`),
      ),
    )
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        eq(repositories.orgId, orgId),
      ),
    )
    .limit(1)
  if (!row) return undefined
  const binding = bindingFromConnectionRow(row.connection)
  if (!binding) return undefined
  return {
    ...binding,
    repositoryName: row.repositoryName,
    githubConnectionId: row.githubConnectionId,
  }
}

export async function listPagerdutyBindingsWithRepoByRepositoryId(
  repositoryId: string,
): Promise<PagerdutyBindingWithRepo[]> {
  const db = getSystemDb()
  const rows = await db
    .select({
      connection: connections,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(connections)
    .innerJoin(
      repositories,
      and(
        eq(repositories.orgId, connections.orgId),
        eq(repositories.id, sql`${connections.config}->>'repositoryId'`),
      ),
    )
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        eq(sql`${connections.config}->>'repositoryId'`, repositoryId),
      ),
    )
  return rows.flatMap((row) => {
    const binding = bindingFromConnectionRow(row.connection)
    if (!binding) return []
    return [
      {
        ...binding,
        repositoryName: row.repositoryName,
        githubConnectionId: row.githubConnectionId,
      },
    ]
  })
}

export async function claimPagerdutyConfigPrCreation(input: {
  connectionId: string
}): Promise<
  | {
      pendingConfigPullUrl: string | null
      setupPhase: PagerdutySetupPhase
    }
  | undefined
> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    if (!row) return undefined
    const binding = bindingFromConnectionRow(row)
    if (!binding) return undefined
    const claimed = await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          setupPhase: "awaiting_merge",
          pendingConfigPrCreating: true,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
          sql`coalesce((${connections.config}->>'pendingConfigPrCreating')::boolean, false) = false`,
        ),
      )
      .returning({ id: connections.id })
    if (claimed.length === 0) return undefined
    return {
      pendingConfigPullUrl: binding.pendingConfigPullUrl,
      setupPhase: binding.setupPhase,
    }
  })
}

export async function releasePagerdutyConfigPrCreationClaim(input: {
  connectionId: string
  previousState: {
    pendingConfigPullUrl: string | null
    setupPhase: PagerdutySetupPhase
  }
}): Promise<void> {
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      binding.setupPhase !== "awaiting_merge" ||
      !binding.pendingConfigPrCreating
    ) {
      return
    }
    await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          pendingConfigPullUrl: input.previousState.pendingConfigPullUrl,
          pendingConfigPrCreating: false,
          setupPhase: input.previousState.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function transitionPagerdutyBindingState(input: {
  connectionId: string
  expectedSetupPhase: PagerdutySetupPhase
  expectedPendingConfigPrCreating: boolean
  repositoryId: string
  branch: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: PagerdutySetupPhase
}): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      !binding.enabled ||
      binding.repositoryId !== input.repositoryId ||
      binding.branch !== input.branch ||
      binding.setupPhase !== input.expectedSetupPhase ||
      binding.pendingConfigPrCreating !== input.expectedPendingConfigPrCreating
    ) {
      return false
    }
    const [updated] = await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          pendingConfigPullUrl: input.pendingConfigPullUrl,
          pendingConfigPrCreating: input.pendingConfigPrCreating,
          setupPhase: input.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning({ id: connections.id })
    return Boolean(updated)
  })
}

export async function claimPagerdutyBindingInitialSync(input: {
  connectionId: string
  repositoryId: string
  branch: string
}): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      !binding.enabled ||
      binding.repositoryId !== input.repositoryId ||
      binding.branch !== input.branch ||
      !(
        binding.setupPhase === "awaiting_merge" ||
        binding.setupPhase === "sync_failed" ||
        binding.setupPhase === "live"
      )
    ) {
      return false
    }
    const [updated] = await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning({ id: connections.id })
    return Boolean(updated)
  })
}

export async function claimPagerdutyContentSyncRetry(
  connectionId: string,
): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      !binding.enabled ||
      binding.setupPhase !== "sync_failed"
    ) {
      return false
    }
    const [claimed] = await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning({ id: connections.id })
    return Boolean(claimed)
  })
}

export async function resetPagerdutyConnectorAfterMissingConfig(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function clearPagerdutySyncBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const db = getOrgDb()
  const ids = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
      ),
    )
  let cleared = 0
  for (const { id } of ids) {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
      )
      const [row] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, id),
            eq(connections.orgId, input.orgId),
            eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
            eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
          ),
        )
        .limit(1)
      if (!row) return false
      await tx
        .update(connections)
        .set({
          config: mergePagerdutyStoredConfig(row, {
            repositoryId: null,
            branch: null,
            enabled: false,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
          }),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, id))
      return true
    })
    if (updated) cleared += 1
  }
  return cleared
}

export async function finalizePagerdutyBindingAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (!row || !binding || binding.setupPhase !== "initial_sync") return false
    const [updated] = await tx
      .update(connections)
      .set({
        config: mergePagerdutyStoredConfig(row, {
          setupPhase:
            input.workflowStatus === "completed" ? "live" : "sync_failed",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning({ id: connections.id })
    return Boolean(updated)
  })
}

type BindingPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch: string
  enabled: boolean
}

async function resolveRepositoryIdForPagerdutySync(
  tx: Db,
  orgId: string,
  sync: BindingPatchInput,
  githubConnectionId: string | undefined,
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
  if (!githubConnectionId) {
    throw new Error("GitHub connection is required for a new repository")
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
      githubConnectionId,
    })
    .returning({ id: repositories.id })
  if (!created) throw new Error("Failed to create repository")

  const [checkout] = await tx
    .insert(repositoryCheckouts)
    .values({
      id: checkoutId,
      repositoryId: id,
      ref: "main",
      checkoutKey: DEFAULT_CHECKOUT_KEY,
    })
    .returning({ id: repositoryCheckouts.id })
  if (!checkout) throw new Error("Failed to create repository checkout")

  return { repositoryId: id, didCreate: true }
}

export async function patchPagerdutyConnectorConfig(input: {
  orgId: string
  connectionId: string
  syncTarget?: BindingPatchInput
}): Promise<{
  bindingChanged: boolean
  repositoryIngestion?: {
    orgId: string
    repositoryId: string
    targetBranch?: string
  }
}> {
  if (input.syncTarget === undefined) {
    return { bindingChanged: false }
  }
  const syncTarget = input.syncTarget

  const githubConnections = await listGithubConnectionsForOrg(input.orgId)
  const requestedGithubConnectionId = syncTarget.githubConnectionId
  if (
    requestedGithubConnectionId &&
    !githubConnections.some(
      (connection) => connection.id === requestedGithubConnectionId,
    )
  ) {
    throw new Error("GitHub connection not found for organization")
  }
  const githubConnectionId =
    requestedGithubConnectionId ??
    (githubConnections.length === 1 ? githubConnections[0]?.id : undefined)

  const db = getOrgDb()
  return db.transaction(async (tx) => {
    let repositoryIngestion:
      | {
          orgId: string
          repositoryId: string
          targetBranch?: string
        }
      | undefined

    const { repositoryId, didCreate } =
      await resolveRepositoryIdForPagerdutySync(
        tx,
        input.orgId,
        syncTarget,
        githubConnectionId,
      )
    if (didCreate) {
      repositoryIngestion = {
        orgId: input.orgId,
        repositoryId,
        targetBranch: syncTarget.branch,
      }
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [connectionRow] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      )
      .limit(1)
    if (!connectionRow) {
      throw new Error("PagerDuty connection does not belong to organization")
    }
    const existingTarget = bindingFromConnectionRow(connectionRow)
    const plan = planPagerdutySyncBindingUpdate({
      existing: existingTarget,
      repositoryId,
      branch: syncTarget.branch,
      enabled: syncTarget.enabled,
    })

    if (plan.changed) {
      await tx
        .update(connections)
        .set({
          config: mergePagerdutyStoredConfig(connectionRow, {
            repositoryId,
            branch: syncTarget.branch,
            enabled: syncTarget.enabled,
            ...(plan.resetLifecycle
              ? {
                  setupPhase: "draft" as const,
                  pendingConfigPullUrl: null,
                  pendingConfigPrCreating: false,
                }
              : {}),
          }),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, input.connectionId))
    }

    return {
      bindingChanged: plan.changed,
      repositoryIngestion,
    }
  })
}
