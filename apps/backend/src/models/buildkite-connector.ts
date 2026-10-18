import { and, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import {
  CONNECTION_TYPE_BUILDKITE,
  connections,
} from "../db/schema/connections.js"
import {
  type BuildkiteConnectionConfigStored,
  buildkiteConnectionConfigStoredSchema,
} from "../lib/connection-config.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"
import { generateObjectId } from "../lib/id.js"
import {
  deleteConnectionDirectory,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import type { ConnectionRow } from "./connection-rows.js"

/** A Buildkite connection with its API access token decrypted. */
export type BuildkiteConnection = {
  id: string
  orgId: string
  organizationSlug: string
  apiToken: string
  /** The ciphertext, to compare and set when the token stops working. */
  apiTokenEnc: string
  hasWebhookToken: boolean
  status: BuildkiteConnectionConfigStored["status"]
  sourceSync: BuildkiteConnectionConfigStored["sourceSync"]
}

function toConnection(row: ConnectionRow, env: Env): BuildkiteConnection {
  const config = buildkiteConnectionConfigStoredSchema.parse(row.config)
  return {
    id: row.id,
    orgId: row.orgId,
    organizationSlug: config.organizationSlug,
    apiToken: decryptConnectionSecret(config.apiTokenEnc, env),
    apiTokenEnc: config.apiTokenEnc,
    hasWebhookToken: Boolean(config.webhookTokenEnc),
    status: config.status,
    sourceSync: config.sourceSync,
  }
}

const buildkiteRowWhere = (orgId: string, connectionId: string) =>
  and(
    eq(connections.id, connectionId),
    eq(connections.orgId, orgId),
    eq(connections.type, CONNECTION_TYPE_BUILDKITE),
  )

export async function getBuildkiteConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<BuildkiteConnection | undefined> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(connections)
      .where(buildkiteRowWhere(orgId, connectionId))
      .limit(1),
  )
  return row ? toConnection(row, env) : undefined
}

/** The status of a connection, without a decrypt of its secrets. */
export async function getBuildkiteConnectionStatus(
  orgId: string,
  connectionId: string,
): Promise<BuildkiteConnectionConfigStored["status"] | undefined> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(buildkiteRowWhere(orgId, connectionId))
      .limit(1),
  )
  return row
    ? buildkiteConnectionConfigStoredSchema.parse(row.config).status
    : undefined
}

/**
 * Create a connection with a checked API access token, or replace the token
 * of `connectionId` (a reconnect). A reconnect keeps the organization, so
 * the sources of the connection stay valid.
 */
export async function saveBuildkiteConnection(input: {
  orgId: string
  env: Env
  connectionId?: string
  organizationSlug: string
  apiToken: string
}): Promise<
  { ok: true; connectionId: string } | { ok: false; status: 404 | 409 }
> {
  const apiTokenEnc = encryptConnectionSecret(input.apiToken.trim(), input.env)
  const row = await withOrgDbContext(input.orgId, async (db) => {
    if (!input.connectionId) {
      const [inserted] = await db
        .insert(connections)
        .values({
          id: generateObjectId("con"),
          orgId: input.orgId,
          type: CONNECTION_TYPE_BUILDKITE,
          config: {
            organizationSlug: input.organizationSlug,
            apiTokenEnc,
            status: "installed",
          } satisfies BuildkiteConnectionConfigStored,
        })
        .returning()
      return inserted
    }
    const [current] = await db
      .select()
      .from(connections)
      .where(buildkiteRowWhere(input.orgId, input.connectionId))
      .limit(1)
    if (!current) return 404 as const
    const config = buildkiteConnectionConfigStoredSchema.parse(current.config)
    if (config.organizationSlug !== input.organizationSlug) return 409 as const
    const [updated] = await db
      .update(connections)
      .set({
        config: sql`${connections.config} || ${JSON.stringify({
          apiTokenEnc,
          status: "installed",
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(buildkiteRowWhere(input.orgId, input.connectionId))
      .returning()
    return updated
  })
  if (row === 404 || row === 409) return { ok: false, status: row }
  if (!row) throw new Error("Failed to save the Buildkite connection")
  await upsertConnectionDirectory(row)
  return { ok: true, connectionId: row.id }
}

/** Save the token of the webhook that the admin added in Buildkite. */
export async function saveBuildkiteWebhookToken(input: {
  orgId: string
  connectionId: string
  env: Env
  webhookToken: string
}): Promise<boolean> {
  const webhookTokenEnc = encryptConnectionSecret(
    input.webhookToken.trim(),
    input.env,
  )
  const updated = await withOrgDbContext(input.orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`jsonb_set(${connections.config}, '{webhookTokenEnc}', ${JSON.stringify(webhookTokenEnc)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(buildkiteRowWhere(input.orgId, input.connectionId))
      .returning({ id: connections.id }),
  )
  return updated.length > 0
}

/**
 * Mark the connection revoked after Buildkite refused its token. The update
 * applies only while the row still has that token, so a reconnect that
 * saved a new token stays installed.
 */
export async function markBuildkiteConnectionRevoked(input: {
  orgId: string
  connectionId: string
  apiTokenEnc: string
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
          buildkiteRowWhere(input.orgId, input.connectionId),
          sql`${connections.config}->>'apiTokenEnc' = ${input.apiTokenEnc}`,
        ),
      ),
  )
}

export async function deleteBuildkiteConnection(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const deleted = await withOrgDbContext(orgId, (db) =>
    db
      .delete(connections)
      .where(buildkiteRowWhere(orgId, connectionId))
      .returning({ id: connections.id }),
  )
  if (deleted.length) await deleteConnectionDirectory(connectionId)
  return deleted.length > 0
}

/**
 * The webhook route knows only the connection id from its path. Read the
 * row through the directory, without an org context.
 */
export async function getBuildkiteWebhookTarget(
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
  if (row?.type !== CONNECTION_TYPE_BUILDKITE) return undefined
  const parsed = buildkiteConnectionConfigStoredSchema.safeParse(row.config)
  if (!parsed.success) return undefined
  const config = parsed.data
  return {
    orgId: row.orgId,
    status: config.status,
    webhookToken: config.webhookTokenEnc
      ? decryptConnectionSecret(config.webhookTokenEnc, env)
      : null,
  }
}
