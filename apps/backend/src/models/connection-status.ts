import type { ConnectionType } from "../db/schema/connections.js"
import {
  buildkiteConnectionConfigStoredSchema,
  forgeConnectionConfigSchema,
  githubConnectionConfigStoredSchema,
  linearConnectionConfigStoredSchema,
  notionConnectionConfigSchema,
  pagerdutyConnectionConfigStoredSchema,
  plainConnectionConfigStoredSchema,
  slackConnectionConfigStoredSchema,
} from "../lib/connection-config.js"
import { linearConnectionIsInstalled } from "./linear-oauth-app.js"

/**
 * The health of one connection, from its stored row only. The connectors
 * list gives one of these values for each connection, so the catalog needs
 * no status read for each connection.
 */
export const CONNECTION_STATUSES = [
  "connected",
  "needs_reconnect",
  "setup_pending",
] as const

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

/*
 * The install rule of each provider. Each rule reads only the fields that
 * the parsed stored config and the connection that a status route resolves
 * both have. The connectors list and the `isInstalled` field of each
 * provider status route use the same rule, so they cannot drift.
 */

/** GitHub has no revoked state: an uninstall removes the installation. */
function githubConnectionIsInstalled(connection: {
  installationId?: number | null
}): boolean {
  const { installationId } = connection
  return (
    typeof installationId === "number" &&
    Number.isSafeInteger(installationId) &&
    installationId > 0
  )
}

/** The Marketplace install event binds the site (`cloudId`). */
export function forgeConnectionIsInstalled(connection: {
  status: string
  cloudId?: string | null
}): boolean {
  return connection.status === "installed" && Boolean(connection.cloudId)
}

export function slackConnectionIsInstalled(connection: {
  status: string
  botTokenEnc?: string | null
}): boolean {
  return connection.status === "installed" && Boolean(connection.botTokenEnc)
}

/** `accessToken`: any form of the token. Only its presence counts. */
export function notionConnectionIsInstalled(connection: {
  status: string
  accessToken?: string | null
}): boolean {
  return connection.status === "installed" && Boolean(connection.accessToken)
}

export function pagerdutyConnectionIsInstalled(connection: {
  status: string
}): boolean {
  return connection.status === "installed"
}

/** A revoked or uninstalled connection needs a reconnect, not a new setup. */
function needsReconnect(status: string | undefined): boolean {
  return status === "revoked" || status === "uninstalled"
}

function statusFrom(
  installationStatus: string | undefined,
  installed: boolean,
): ConnectionStatus {
  if (needsReconnect(installationStatus)) return "needs_reconnect"
  return installed ? "connected" : "setup_pending"
}

/**
 * The health of a connection from its stored config. A config that does not
 * parse has an unfinished setup.
 *
 * The rule reads the connection (the auth) only. The sync phases of the old
 * sync binding (`setupPhase`) are not connection health (ADR-050), so an
 * installed row is connected in every phase, also `sync_failed` and
 * `config_failed`. No rule calls the provider: a token that the provider
 * revoked shows here only after a sync or a webhook writes
 * `status: "revoked"`.
 */
export function storedConnectionStatus(
  type: ConnectionType,
  config: unknown,
): ConnectionStatus {
  switch (type) {
    case "github": {
      const parsed = githubConnectionConfigStoredSchema.safeParse(config)
      return statusFrom(
        undefined,
        parsed.success && githubConnectionIsInstalled(parsed.data),
      )
    }
    case "forge": {
      // A row without a status key is pending (see the schema).
      const parsed = forgeConnectionConfigSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      return statusFrom(
        parsed.data.status,
        forgeConnectionIsInstalled(parsed.data),
      )
    }
    case "slack": {
      // A row without a status key is pending (see the schema).
      const parsed = slackConnectionConfigStoredSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      return statusFrom(
        parsed.data.status,
        slackConnectionIsInstalled(parsed.data),
      )
    }
    case "linear": {
      // A row from before the status key is installed (see the schema).
      const parsed = linearConnectionConfigStoredSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      const stored = parsed.data
      return statusFrom(
        stored.status,
        linearConnectionIsInstalled({
          status: stored.status,
          // Only the presence of the token counts.
          accessToken: stored.accessTokenEnc ?? null,
          workspaceId: stored.workspaceId ?? null,
        }),
      )
    }
    case "notion": {
      // A row from before the status key is installed (see the schema).
      const parsed = notionConnectionConfigSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      const stored = parsed.data
      return statusFrom(
        stored.status,
        notionConnectionIsInstalled({
          status: stored.status,
          // The encrypted token, or the plaintext token of an old row.
          accessToken: stored.accessTokenEnc ?? stored.accessToken,
        }),
      )
    }
    case "pagerduty": {
      // A row from before the status key is installed (see the schema).
      const parsed = pagerdutyConnectionConfigStoredSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      return statusFrom(
        parsed.data.status,
        pagerdutyConnectionIsInstalled(parsed.data),
      )
    }
    case "buildkite": {
      // A row exists only after the token is saved.
      const parsed = buildkiteConnectionConfigStoredSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      return statusFrom(parsed.data.status, parsed.data.status === "installed")
    }
    case "plain": {
      // A row exists only after the key is saved.
      const parsed = plainConnectionConfigStoredSchema.safeParse(config)
      if (!parsed.success) return "setup_pending"
      return statusFrom(parsed.data.status, parsed.data.status === "installed")
    }
  }
}
