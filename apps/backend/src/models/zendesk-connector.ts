import { and, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import {
  CONNECTION_TYPE_ZENDESK,
  connections,
} from "../db/schema/connections.js"
import {
  type ZendeskConnectionConfigStored,
  zendeskConnectionConfigStoredSchema,
} from "../lib/connection-config.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"
import type { ZendeskOAuthClient } from "../services/zendesk/oauth.js"
import {
  deleteConnectionDirectory,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import type { ConnectionRow } from "./connection-rows.js"

/** A Zendesk connection with its secrets decrypted. Never return it from a route. */
export type ZendeskConnection = {
  id: string
  orgId: string
  subdomain: string
  status: ZendeskConnectionConfigStored["status"]
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: string | null
  /** The ciphertexts, to compare and set: a revoke and a token refresh. */
  accessTokenEnc: string | null
  refreshTokenEnc: string | null
  /** The client that the token requests use: the row's, then the env's. */
  oauthClient: ZendeskOAuthClient | null
  webhookId: string | null
  sourceSync: ZendeskConnectionConfigStored["sourceSync"]
}

const parseConfig = (row: { config: unknown }) =>
  zendeskConnectionConfigStoredSchema.parse(row.config)

/** The row's OAuth client first (self-host), then the deployment's (hosted). */
function resolveZendeskOAuthClient(
  config: Pick<
    ZendeskConnectionConfigStored,
    "oauthClientId" | "oauthClientSecretEnc"
  >,
  env: Env,
): ZendeskOAuthClient | null {
  if (config.oauthClientId && config.oauthClientSecretEnc)
    return {
      clientId: config.oauthClientId,
      clientSecret: decryptConnectionSecret(config.oauthClientSecretEnc, env),
    }
  return env.ZENDESK_CLIENT_ID && env.ZENDESK_CLIENT_SECRET
    ? {
        clientId: env.ZENDESK_CLIENT_ID,
        clientSecret: env.ZENDESK_CLIENT_SECRET,
      }
    : null
}

function toConnection(row: ConnectionRow, env: Env): ZendeskConnection {
  const config = parseConfig(row)
  const decrypt = (value: string | undefined) =>
    value ? decryptConnectionSecret(value, env) : null
  return {
    id: row.id,
    orgId: row.orgId,
    subdomain: config.subdomain,
    status: config.status,
    accessToken: decrypt(config.accessTokenEnc),
    refreshToken: decrypt(config.refreshTokenEnc),
    accessTokenExpiresAt: config.accessTokenExpiresAt ?? null,
    accessTokenEnc: config.accessTokenEnc ?? null,
    refreshTokenEnc: config.refreshTokenEnc ?? null,
    oauthClient: resolveZendeskOAuthClient(config, env),
    webhookId: config.webhookId ?? null,
    sourceSync: config.sourceSync,
  }
}

const zendeskRowWhere = (orgId: string, connectionId: string) =>
  and(
    eq(connections.id, connectionId),
    eq(connections.orgId, orgId),
    eq(connections.type, CONNECTION_TYPE_ZENDESK),
  )

export async function getZendeskConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<ZendeskConnection | undefined> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(connections)
      .where(zendeskRowWhere(orgId, connectionId))
      .limit(1),
  )
  return row ? toConnection(row, env) : undefined
}

/** The status of a connection, without a decrypt of its secrets. */
export async function getZendeskConnectionStatus(
  orgId: string,
  connectionId: string,
): Promise<ZendeskConnectionConfigStored["status"] | undefined> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(zendeskRowWhere(orgId, connectionId))
      .limit(1),
  )
  return row ? parseConfig(row).status : undefined
}

/**
 * Start a setup for a subdomain. A pending setup of the same subdomain in
 * the org is used again, so a retried setup adds no rows.
 */
export async function createZendeskDraft(input: {
  orgId: string
  subdomain: string
}): Promise<string> {
  const row = await withOrgDbContext(input.orgId, async (db) => {
    const [pending] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_ZENDESK),
          sql`${connections.config}->>'subdomain' = ${input.subdomain}`,
          sql`${connections.config}->>'status' = 'pending'`,
        ),
      )
      .limit(1)
    if (pending) return pending
    const [inserted] = await db
      .insert(connections)
      .values({
        id: generateObjectId("con"),
        orgId: input.orgId,
        type: CONNECTION_TYPE_ZENDESK,
        config: {
          subdomain: input.subdomain,
          status: "pending",
        } satisfies ZendeskConnectionConfigStored,
      })
      .returning()
    return inserted
  })
  if (!row) throw new Error("Failed to create the Zendesk setup")
  await upsertConnectionDirectory(row)
  return row.id
}

/** Merge keys into the stored config of one connection. */
async function patchConfig(
  orgId: string,
  connectionId: string,
  patch: Partial<ZendeskConnectionConfigStored>,
  extraWhere?: ReturnType<typeof sql>,
): Promise<boolean> {
  const updated = await withOrgDbContext(orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`${connections.config} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        extraWhere
          ? and(zendeskRowWhere(orgId, connectionId), extraWhere)
          : zendeskRowWhere(orgId, connectionId),
      )
      .returning({ id: connections.id }),
  )
  return updated.length > 0
}

/** Save the local OAuth client of a self-hosted deployment on the row. */
export function saveZendeskOAuthClient(input: {
  orgId: string
  connectionId: string
  env: Env
  clientId: string
  clientSecret: string
}): Promise<boolean> {
  return patchConfig(input.orgId, input.connectionId, {
    oauthClientId: input.clientId.trim(),
    oauthClientSecretEnc: encryptConnectionSecret(
      input.clientSecret.trim(),
      input.env,
    ),
  })
}

export function saveZendeskTokens(input: {
  orgId: string
  connectionId: string
  env: Env
  tokens: {
    accessToken: string
    refreshToken: string | null
    accessTokenExpiresAt: string | null
  }
}): Promise<boolean> {
  return patchConfig(input.orgId, input.connectionId, {
    status: "installed",
    accessTokenEnc: encryptConnectionSecret(
      input.tokens.accessToken,
      input.env,
    ),
    ...(input.tokens.refreshToken
      ? {
          refreshTokenEnc: encryptConnectionSecret(
            input.tokens.refreshToken,
            input.env,
          ),
        }
      : {}),
    accessTokenExpiresAt: input.tokens.accessTokenExpiresAt,
  })
}

export function saveZendeskWebhook(input: {
  orgId: string
  connectionId: string
  env: Env
  webhookId: string
  signingSecret: string
}): Promise<boolean> {
  return patchConfig(input.orgId, input.connectionId, {
    webhookId: input.webhookId,
    webhookSecretEnc: encryptConnectionSecret(input.signingSecret, input.env),
  })
}

/**
 * Mark the connection revoked after Zendesk refused its token. The update
 * applies only while the row still has that token, so a reconnect that
 * saved new tokens stays installed.
 */
export async function markZendeskConnectionRevoked(input: {
  orgId: string
  connectionId: string
  accessTokenEnc: string
}): Promise<void> {
  await patchConfig(
    input.orgId,
    input.connectionId,
    { status: "revoked" },
    sql`${connections.config}->>'accessTokenEnc' = ${input.accessTokenEnc}`,
  )
}

/**
 * Save the tokens of a refresh, only while the row still has the refresh
 * token that the refresh spent. Zendesk rotates the refresh token, so a
 * second caller loses this compare and set. The refresh itself runs
 * outside any transaction.
 */
export function saveRefreshedZendeskTokens(input: {
  orgId: string
  connectionId: string
  env: Env
  spentRefreshTokenEnc: string
  tokens: {
    accessToken: string
    refreshToken: string | null
    accessTokenExpiresAt: string | null
  }
}): Promise<boolean> {
  return patchConfig(
    input.orgId,
    input.connectionId,
    {
      status: "installed",
      accessTokenEnc: encryptConnectionSecret(
        input.tokens.accessToken,
        input.env,
      ),
      ...(input.tokens.refreshToken
        ? {
            refreshTokenEnc: encryptConnectionSecret(
              input.tokens.refreshToken,
              input.env,
            ),
          }
        : {}),
      accessTokenExpiresAt: input.tokens.accessTokenExpiresAt,
    },
    sql`${connections.config}->>'refreshTokenEnc' = ${input.spentRefreshTokenEnc}`,
  )
}

export async function deleteZendeskConnection(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const deleted = await withOrgDbContext(orgId, (db) =>
    db
      .delete(connections)
      .where(zendeskRowWhere(orgId, connectionId))
      .returning({ id: connections.id }),
  )
  if (deleted.length) await deleteConnectionDirectory(connectionId)
  return deleted.length > 0
}

/**
 * The webhook route knows only the connection id from its path. Read the
 * row through the directory, without an org context.
 */
export async function getZendeskWebhookTarget(
  connectionId: string,
  env: Env,
): Promise<
  | {
      orgId: string
      status: ZendeskConnectionConfigStored["status"]
      webhookSecret: string | null
    }
  | undefined
> {
  const row = await loadConnectionViaDirectory(connectionId)
  if (row?.type !== CONNECTION_TYPE_ZENDESK) return undefined
  const parsed = zendeskConnectionConfigStoredSchema.safeParse(row.config)
  if (!parsed.success) return undefined
  const config = parsed.data
  let webhookSecret: string | null = null
  if (config.webhookSecretEnc) {
    try {
      webhookSecret = decryptConnectionSecret(config.webhookSecretEnc, env)
    } catch {
      // A secret that does not decrypt (a changed key) gets the same answer
      // as an unknown connection, and the sender cannot tell them apart.
      log.warn({
        step: "zendesk_webhook.decrypt",
        message: "The webhook secret of a Zendesk connection does not decrypt",
        connectionId,
      })
      return undefined
    }
  }
  return { orgId: row.orgId, status: config.status, webhookSecret }
}
