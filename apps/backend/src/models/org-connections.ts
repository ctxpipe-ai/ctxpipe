import { asc, eq } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { type ConnectionType, connections } from "../db/schema/connections.js"
import {
  forgeConnectionConfigSchema,
  linearConnectionConfigStoredSchema,
  notionConnectionConfigSchema,
  pagerdutyConnectionConfigStoredSchema,
} from "../lib/connection-config.js"
import { isEmptyForgeSetupDraft } from "./atlassian-connector.js"
import { isEmptyLinearSetupDraft } from "./linear-connector.js"
import { isEmptyNotionSetupDraft } from "./notion-connector.js"
import { isEmptyPagerdutySetupDraft } from "./pagerduty-connector.js"

export type OrgConnectionListItem = {
  id: string
  type: ConnectionType
  createdAt: Date
  updatedAt: Date
}

/**
 * True for a draft that only a setup first screen created. A row that does
 * not parse stays listed, so the operator can see and remove it.
 */
function isEmptySetupDraft(type: ConnectionType, config: unknown): boolean {
  switch (type) {
    case "forge": {
      const parsed = forgeConnectionConfigSchema.safeParse(config)
      return parsed.success && isEmptyForgeSetupDraft(parsed.data)
    }
    case "notion": {
      const parsed = notionConnectionConfigSchema.safeParse(config)
      return parsed.success && isEmptyNotionSetupDraft(parsed.data)
    }
    case "linear": {
      const parsed = linearConnectionConfigStoredSchema.safeParse(config)
      return parsed.success && isEmptyLinearSetupDraft(parsed.data)
    }
    case "pagerduty": {
      const parsed = pagerdutyConnectionConfigStoredSchema.safeParse(config)
      return parsed.success && isEmptyPagerdutySetupDraft(parsed.data)
    }
    default:
      return false
  }
}

/**
 * Metadata only — never exposes `config` (secrets). Leaves out empty setup
 * drafts: opening a wizard must not add a connection to the list.
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
    .filter((row) => !isEmptySetupDraft(row.type, row.config))
    .map(({ config: _config, ...item }) => item)
}
