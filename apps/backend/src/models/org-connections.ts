import { asc, eq } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { type ConnectionType, connections } from "../db/schema/connections.js"
import {
  forgeConnectionConfigSchema,
  linearConnectionConfigStoredSchema,
  notionConnectionConfigSchema,
  pagerdutyConnectionConfigStoredSchema,
} from "../lib/connection-config.js"

export type OrgConnectionListItem = {
  id: string
  type: ConnectionType
  createdAt: Date
  updatedAt: Date
}

/**
 * True while a setup wizard holds the row only to keep its state (OAuth app,
 * install intent) and no provider account is linked yet. A row that does not
 * parse stays listed, so the operator can see and remove it.
 */
function isUnlinkedSetupDraft(type: ConnectionType, config: unknown): boolean {
  switch (type) {
    case "forge": {
      const parsed = forgeConnectionConfigSchema.safeParse(config)
      return (
        parsed.success && !parsed.data.cloudId && !parsed.data.installationId
      )
    }
    case "notion": {
      const parsed = notionConnectionConfigSchema.safeParse(config)
      return (
        parsed.success &&
        !parsed.data.workspaceId &&
        !parsed.data.accessTokenEnc &&
        !parsed.data.accessToken
      )
    }
    case "linear": {
      const parsed = linearConnectionConfigStoredSchema.safeParse(config)
      return parsed.success && !parsed.data.workspaceId
    }
    case "pagerduty": {
      const parsed = pagerdutyConnectionConfigStoredSchema.safeParse(config)
      return (
        parsed.success &&
        parsed.data.accountId.startsWith("pending:") &&
        !parsed.data.accessTokenEnc
      )
    }
    default:
      return false
  }
}

/**
 * Metadata only — never exposes `config` (secrets). Leaves out setup drafts
 * that have no linked provider account: opening a wizard must not add a
 * connection to the list.
 */
export async function listOrgConnections(
  orgId: string,
): Promise<OrgConnectionListItem[]> {
  const rows = await withOrgDbContext(orgId, async () => {
    return getOrgDb()
      .select({
        id: connections.id,
        type: connections.type,
        config: connections.config,
        createdAt: connections.createdAt,
        updatedAt: connections.updatedAt,
      })
      .from(connections)
      .where(eq(connections.orgId, orgId))
      .orderBy(asc(connections.createdAt))
  })
  return rows
    .filter((row) => !isUnlinkedSetupDraft(row.type, row.config))
    .map(({ config: _config, ...item }) => item)
}
