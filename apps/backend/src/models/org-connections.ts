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

/**
 * The health of one connection, from its stored row only. The catalog shows
 * one state for each provider from these values, so it needs no status read
 * for each connection.
 */
type OrgConnectionStatus =
  | "connected"
  | "needs_reconnect"
  | "setup_pending"

type OrgConnectionListItem = {
  id: string
  type: ConnectionType
  /** The account, site, or workspace name that the provider gives. */
  displayName: string | null
  status: OrgConnectionStatus
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
  buildkite: ["organizationSlug"],
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

/** True when the config has a non-empty string at `key`. */
function hasText(config: Record<string, unknown>, key: string): boolean {
  const value = config[key]
  return typeof value === "string" && value.length > 0
}

/**
 * The same rule as the `isInstalled` field of each provider status route,
 * and `resolveConnectorHealth` in the UI. A revoked or uninstalled row needs a
 * reconnect. A row that is not installed has an unfinished setup.
 *
 * The rule reads the connection (the auth) only. The sync phases of the old
 * sync binding (`setupPhase`) are not connection health (ADR-050), so an
 * installed row is connected in every phase. No rule calls the provider: a
 * token that the provider revoked shows here only after a sync or a webhook
 * writes `status: "revoked"`.
 */
function connectionStatus(
  type: ConnectionType,
  config: unknown,
): OrgConnectionStatus {
  const row =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {}
  // Linear, Notion, and PagerDuty rows from before the status key are
  // installed; Forge and Slack rows without it are pending (see their
  // config schemas in `lib/connection-config.ts`).
  const status = typeof row.status === "string" ? row.status : undefined
  if (status === "revoked" || status === "uninstalled") return "needs_reconnect"
  const installed = (() => {
    switch (type) {
      case "github": {
        // GitHub has no revoked state: an uninstall removes the installation.
        const installationId = row.installationId
        return (
          typeof installationId === "number" &&
          Number.isSafeInteger(installationId) &&
          installationId > 0
        )
      }
      case "forge":
        return status === "installed" && hasText(row, "cloudId")
      case "linear":
        return (
          (status ?? "installed") === "installed" &&
          hasText(row, "accessTokenEnc") &&
          hasText(row, "workspaceId")
        )
      case "notion":
        return (
          (status ?? "installed") === "installed" &&
          (hasText(row, "accessTokenEnc") || hasText(row, "accessToken"))
        )
      case "pagerduty":
        return (status ?? "installed") === "installed"
      case "slack":
        return status === "installed" && hasText(row, "botTokenEnc")
      case "buildkite":
      case "plain":
        // A row exists only after the token or key is saved.
        return status === "installed"
    }
  })()
  return installed ? "connected" : "setup_pending"
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
      status: connectionStatus(item.type, config),
    }))
}
