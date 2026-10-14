import type { Env } from "../../config/env.js"
import {
  markZendeskConnectionRevoked,
  refreshZendeskTokensWithLock,
  type ZendeskConnection,
} from "../../models/zendesk-connector.js"
import {
  refreshZendeskToken,
  ZendeskAuthorizationRevokedError,
} from "./oauth.js"

/**
 * A usable access token for the connection: the stored one while it is
 * valid for one more minute, else a refresh under the connection lock.
 * When Zendesk refuses the refresh, the connection becomes revoked.
 */
export async function freshZendeskAccessToken(input: {
  orgId: string
  env: Env
  connection: ZendeskConnection
}): Promise<string> {
  const { connection } = input
  if (!connection.accessToken)
    throw new ZendeskAuthorizationRevokedError("The connection has no token")
  const expiresAt = connection.accessTokenExpiresAt
  if (!expiresAt || Date.parse(expiresAt) - 60_000 > Date.now())
    return connection.accessToken
  const client = connection.oauthClient
  if (!connection.refreshToken || !client)
    throw new ZendeskAuthorizationRevokedError("The token cannot be refreshed")
  try {
    const refreshed = await refreshZendeskTokensWithLock({
      orgId: input.orgId,
      connectionId: connection.id,
      env: input.env,
      expectedRefreshToken: connection.refreshToken,
      refresh: (refreshToken) =>
        refreshZendeskToken({
          subdomain: connection.subdomain,
          creds: client,
          refreshToken,
        }),
    })
    return refreshed.accessToken
  } catch (error) {
    if (
      error instanceof ZendeskAuthorizationRevokedError &&
      connection.accessTokenEnc
    )
      await markZendeskConnectionRevoked({
        orgId: input.orgId,
        connectionId: connection.id,
        accessTokenEnc: connection.accessTokenEnc,
      })
    throw error
  }
}
