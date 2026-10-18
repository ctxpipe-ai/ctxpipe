import { and, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { CONNECTION_TYPE_PLAIN, connections } from "../db/schema/connections.js"
import {
  type PlainConnectionConfigStored,
  plainConnectionConfigStoredSchema,
} from "../lib/connection-config.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"
import {
  deleteConnectionDirectory,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import type { ConnectionRow } from "./connection-rows.js"

/** A Plain connection with its API key decrypted. */
export type PlainConnection = {
  id: string
  orgId: string
  workspaceId: string
  workspaceName: string
  apiKey: string
  /** The ciphertext, to compare and set when the key stops working. */
  apiKeyEnc: string
  webhookTargetId: string | null
  status: PlainConnectionConfigStored["status"]
  sourceSync: PlainConnectionConfigStored["sourceSync"]
}

function toConnection(row: ConnectionRow, env: Env): PlainConnection {
  const config = plainConnectionConfigStoredSchema.parse(row.config)
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: config.workspaceId,
    workspaceName: config.workspaceName,
    apiKey: decryptConnectionSecret(config.apiKeyEnc, env),
    apiKeyEnc: config.apiKeyEnc,
    webhookTargetId: config.webhookTargetId ?? null,
    status: config.status,
    sourceSync: config.sourceSync,
  }
}

const plainRowWhere = (orgId: string, connectionId: string) =>
  and(
    eq(connections.id, connectionId),
    eq(connections.orgId, orgId),
    eq(connections.type, CONNECTION_TYPE_PLAIN),
  )

export async function getPlainConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<PlainConnection | undefined> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(connections)
      .where(plainRowWhere(orgId, connectionId))
      .limit(1),
  )
  return row ? toConnection(row, env) : undefined
}

/** The status of a connection, without a decrypt of its secrets. */
export async function getPlainConnectionStatus(
  orgId: string,
  connectionId: string,
): Promise<PlainConnectionConfigStored["status"] | undefined> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(plainRowWhere(orgId, connectionId))
      .limit(1),
  )
  return row
    ? plainConnectionConfigStoredSchema.parse(row.config).status
    : undefined
}

/**
 * Create a connection with a checked API key, or replace the key of
 * `connectionId` (a reconnect). A reconnect keeps the workspace, so the
 * sources and the webhook target of the connection stay valid.
 */
export async function savePlainConnection(input: {
  orgId: string
  env: Env
  connectionId?: string
  workspace: { id: string; name: string }
  apiKey: string
}): Promise<
  { ok: true; connection: PlainConnection } | { ok: false; status: 404 | 409 }
> {
  const apiKeyEnc = encryptConnectionSecret(input.apiKey.trim(), input.env)
  const row = await withOrgDbContext(input.orgId, async (db) => {
    if (!input.connectionId) {
      const [inserted] = await db
        .insert(connections)
        .values({
          id: generateObjectId("con"),
          orgId: input.orgId,
          type: CONNECTION_TYPE_PLAIN,
          config: {
            workspaceId: input.workspace.id,
            workspaceName: input.workspace.name,
            apiKeyEnc,
            status: "installed",
          } satisfies PlainConnectionConfigStored,
        })
        .returning()
      return inserted
    }
    const [current] = await db
      .select()
      .from(connections)
      .where(plainRowWhere(input.orgId, input.connectionId))
      .limit(1)
    if (!current) return 404 as const
    const config = plainConnectionConfigStoredSchema.parse(current.config)
    if (config.workspaceId !== input.workspace.id) return 409 as const
    const [updated] = await db
      .update(connections)
      .set({
        config: sql`${connections.config} || ${JSON.stringify({
          workspaceName: input.workspace.name,
          apiKeyEnc,
          status: "installed",
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(plainRowWhere(input.orgId, input.connectionId))
      .returning()
    return updated
  })
  if (row === 404 || row === 409) return { ok: false, status: row }
  if (!row) throw new Error("Failed to save the Plain connection")
  await upsertConnectionDirectory(row)
  return { ok: true, connection: toConnection(row, input.env) }
}

/**
 * Save the webhook target that ctx| created in Plain, and its token. The
 * save applies only while the row still has `previousTargetId` (the target
 * that the request read), so of two parallel connects only one saves.
 * Gives false when the row changed: the caller deletes its own target.
 */
export async function savePlainWebhookTarget(input: {
  orgId: string
  connectionId: string
  env: Env
  previousTargetId: string | null
  webhookTargetId: string
  webhookToken: string
}): Promise<boolean> {
  const current = sql`${connections.config}->>'webhookTargetId'`
  const updated = await withOrgDbContext(input.orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`${connections.config} || ${JSON.stringify({
          webhookTargetId: input.webhookTargetId,
          webhookTokenEnc: encryptConnectionSecret(
            input.webhookToken,
            input.env,
          ),
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          plainRowWhere(input.orgId, input.connectionId),
          input.previousTargetId === null
            ? sql`${current} is null`
            : sql`${current} = ${input.previousTargetId}`,
        ),
      )
      .returning({ id: connections.id }),
  )
  return updated.length > 0
}

/**
 * Mark the connection revoked after Plain refused its key. The update
 * applies only while the row still has that key, so a reconnect that saved
 * a new key stays installed.
 */
export async function markPlainConnectionRevoked(input: {
  orgId: string
  connectionId: string
  apiKeyEnc: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`jsonb_set(${connections.config}, '{status}', '"revoked"'::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          plainRowWhere(input.orgId, input.connectionId),
          sql`${connections.config}->>'apiKeyEnc' = ${input.apiKeyEnc}`,
        ),
      ),
  )
}

export async function deletePlainConnection(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const deleted = await withOrgDbContext(orgId, (db) =>
    db
      .delete(connections)
      .where(plainRowWhere(orgId, connectionId))
      .returning({ id: connections.id }),
  )
  if (deleted.length) await deleteConnectionDirectory(connectionId)
  return deleted.length > 0
}

/**
 * The webhook route knows only the connection id from its path. Read the
 * row through the directory, without an org context.
 */
export async function getPlainWebhookTarget(
  connectionId: string,
  env: Env,
): Promise<
  | {
      orgId: string
      status: "installed" | "revoked"
      webhookToken: string | null
    }
  | undefined
> {
  const row = await loadConnectionViaDirectory(connectionId)
  if (row?.type !== CONNECTION_TYPE_PLAIN) return undefined
  const parsed = plainConnectionConfigStoredSchema.safeParse(row.config)
  if (!parsed.success) return undefined
  const config = parsed.data
  let webhookToken: string | null = null
  if (config.webhookTokenEnc) {
    try {
      webhookToken = decryptConnectionSecret(config.webhookTokenEnc, env)
    } catch {
      // A token that does not decrypt (a changed key) gets the same answer
      // as an unknown connection, and the sender cannot tell them apart.
      log.warn({
        step: "plain_webhook.decrypt",
        message: "The webhook token of a Plain connection does not decrypt",
        connectionId,
      })
      return undefined
    }
  }
  return { orgId: row.orgId, status: config.status, webhookToken }
}
