import { asc, eq } from "drizzle-orm"

import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { type ConnectionType, connections } from "../db/schema/connections.js"
import {
  linearConnectionConfigStoredSchema,
  notionConnectionConfigSchema,
  pagerdutyConnectionConfigStoredSchema,
} from "../lib/connection-config.js"
import { isEmptyLinearSetupDraft } from "./linear-connector.js"
import { isEmptyNotionSetupDraft } from "./notion-connector.js"
import { isEmptyPagerdutySetupDraft } from "./pagerduty-connector.js"

type OrgConnectionListItem = {
  id: string
  type: ConnectionType
  /** The account, site, or workspace name that the provider gives. */
  displayName: string | null
  createdAt: Date
  updatedAt: Date
}

const DISPLAY_NAME_KEYS: Record<ConnectionType, readonly string[]> = {
  github: ["accountSlug"],
  forge: ["confluenceSiteHost"],
  slack: ["teamName"],
  linear: ["workspaceName"],
  notion: ["workspaceName"],
  pagerduty: ["accountName", "accountSubdomain"],
  plain: ["workspaceName"],
}

/** Read only the non-secret name keys of a connection config. */
function connectionDisplayName(
  type: ConnectionType,
  config: unknown,
): string | null {
  if (!config || typeof config !== "object") return null
  for (const key of DISPLAY_NAME_KEYS[type] ?? []) {
    const value = (config as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

/**
 * True for a draft that only a setup first screen created. A row that does
 * not parse stays listed, so the operator can see and remove it. A pending
 * Forge draft always stays listed: the Marketplace install event binds the
 * installed site to it, and the user must be able to finish or remove it.
 */
function isEmptySetupDraft(type: ConnectionType, config: unknown): boolean {
  switch (type) {
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
    .map(({ config, ...item }) => ({
      ...item,
      displayName: connectionDisplayName(item.type, config),
    }))
}
