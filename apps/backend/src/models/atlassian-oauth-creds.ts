import { and, eq } from "drizzle-orm"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { CONNECTION_TYPE_FORGE, connections } from "../db/schema/connections.js"
import { tryParseForgeConnectionConfig } from "../lib/connection-config.js"

export type AtlassianOauthCreds = {
  clientId: string
  clientSecret: string
}

/**
 * In tests (or `ATLASSIAN_E2E_FALLBACK=1`), use global env when no per-connection config so CI
 * can run without saving 3LO in the DB.
 */
export function getAtlassianGlobalEnvOauthCredsIfAllowed():
  | AtlassianOauthCreds
  | undefined {
  if (
    process.env.NODE_ENV !== "test" &&
    process.env.ATLASSIAN_E2E_FALLBACK !== "1"
  ) {
    return undefined
  }
  const env = parseEnv(process.env as Record<string, string | undefined>)
  if (env.ATLASSIAN_CLIENT_ID && env.ATLASSIAN_CLIENT_SECRET) {
    return {
      clientId: env.ATLASSIAN_CLIENT_ID,
      clientSecret: env.ATLASSIAN_CLIENT_SECRET,
    }
  }
  return undefined
}

/**
 * 3LO client credentials for OAuth authorize + token: read from the Forge `connections.config` row.
 */
export async function getAtlassianOauthCredsForForgeConnection(
  orgId: string,
  connectionId: string,
): Promise<AtlassianOauthCreds | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_FORGE),
      ),
    )
    .limit(1)
  if (!row) return undefined
  const config = tryParseForgeConnectionConfig(row.config)
  if(config?.atlassianOAuthClientId && config?.atlassianOAuthClientSecret) {
    return {
      clientId: config.atlassianOAuthClientId,
      clientSecret: config.atlassianOAuthClientSecret,
    }
  }
  return getAtlassianGlobalEnvOauthCredsIfAllowed()
}

export function forgeConnectionHasAtlassianOauthCredsInConfig(
  config: Record<string, unknown>,
): boolean {
  const c = tryParseForgeConnectionConfig(config)
  if (!c) return false
  return Boolean(c.atlassianOAuthClientId && c.atlassianOAuthClientSecret)
}
