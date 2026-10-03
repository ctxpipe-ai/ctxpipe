import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
import {
  CONNECTION_TYPE_NOTION,
  connections,
} from "../../db/schema/connections.js"
import { parseNotionConnectionConfig } from "../../lib/connection-config.js"
import {
  notionConnectionToShape,
  notionShapeToConfig,
} from "../../models/connection-rows.js"
import type { NotionConnection } from "../../models/notion-connector.js"

async function loadNotionConnectionRow(orgId: string, connectionId: string) {
  return withOrgDbContext(orgId, async () => {
    const [row] = await getOrgDb()
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    return row
  })
}

export async function loadNotionConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<NotionConnection | undefined> {
  const row = await loadNotionConnectionRow(orgId, connectionId)
  return row ? notionConnectionToShape(row, env) : undefined
}

export async function loadNotionStoredConfig(
  orgId: string,
  connectionId: string,
) {
  const row = await loadNotionConnectionRow(orgId, connectionId)
  return row
    ? parseNotionConnectionConfig(row.config as Record<string, unknown>)
    : undefined
}

export async function writeNotionConnectionTokens(input: {
  orgId: string
  connectionId: string
  env: Env
  accessToken: string
  refreshToken: string | null
}): Promise<NotionConnection | undefined> {
  const row = await loadNotionConnectionRow(input.orgId, input.connectionId)
  if (!row) return undefined
  const current = notionConnectionToShape(row, input.env)
  const stored = parseNotionConnectionConfig(
    row.config as Record<string, unknown>,
  )
  const [updated] = await withOrgDbContext(input.orgId, () =>
    getOrgDb()
      .update(connections)
      .set({
        config: {
          ...notionShapeToConfig(
            {
              ...current,
              accessToken: input.accessToken,
              refreshToken: input.refreshToken,
            },
            input.env,
          ),
          oauthClientId: stored.oauthClientId,
          oauthClientSecretEnc: stored.oauthClientSecretEnc,
          webhookSecretEnc: stored.webhookSecretEnc,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .returning(),
  )
  return updated ? notionConnectionToShape(updated, input.env) : undefined
}
