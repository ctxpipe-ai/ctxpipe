import type { Env } from "../../config/env.js"
import {
  getZendeskConnection,
  markZendeskConnectionRevoked,
  saveRefreshedZendeskTokens,
  type ZendeskConnection,
} from "../../models/zendesk-connector.js"
import {
  refreshZendeskToken,
  ZendeskAuthorizationRevokedError,
} from "./oauth.js"

/**
 * The access token of a caller that lost the refresh race: another caller
 * spent the same refresh token and saved new tokens. Read the row a few
 * times, because the winner saves after its refresh returns.
 */
async function tokenOfRaceWinner(
  orgId: string,
  connection: ZendeskConnection,
  env: Env,
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getZendeskConnection(orgId, connection.id, env)
    if (
      current?.accessToken &&
      current.refreshTokenEnc !== connection.refreshTokenEnc
    )
      return current.accessToken
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

/**
 * A usable access token for the connection: the stored one while it is
 * valid for one more minute, else a refresh. The refresh runs outside any
 * transaction, and the new tokens save only while the row still has the
 * spent refresh token. When Zendesk refuses the refresh and no other caller
 * refreshed, the connection becomes revoked.
 */
export async function freshZendeskAccessToken(input: {
  orgId: string
  env: Env
  connection: ZendeskConnection
}): Promise<string> {
  const { orgId, env, connection } = input
  if (!connection.accessToken)
    throw new ZendeskAuthorizationRevokedError("The connection has no token")
  const expiresAt = connection.accessTokenExpiresAt
  if (!expiresAt || Date.parse(expiresAt) - 60_000 > Date.now())
    return connection.accessToken
  const client = connection.oauthClient
  if (!connection.refreshToken || !connection.refreshTokenEnc || !client)
    throw new ZendeskAuthorizationRevokedError("The token cannot be refreshed")
  let tokens: Awaited<ReturnType<typeof refreshZendeskToken>>
  try {
    tokens = await refreshZendeskToken({
      subdomain: connection.subdomain,
      creds: client,
      refreshToken: connection.refreshToken,
    })
  } catch (error) {
    if (!(error instanceof ZendeskAuthorizationRevokedError)) throw error
    const winner = await tokenOfRaceWinner(orgId, connection, env)
    if (winner) return winner
    if (connection.accessTokenEnc)
      await markZendeskConnectionRevoked({
        orgId,
        connectionId: connection.id,
        accessTokenEnc: connection.accessTokenEnc,
      })
    throw error
  }
  await saveRefreshedZendeskTokens({
    orgId,
    connectionId: connection.id,
    env,
    spentRefreshTokenEnc: connection.refreshTokenEnc,
    tokens,
  })
  return tokens.accessToken
}
