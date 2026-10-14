import type { Env } from "../../config/env.js"
import { formatUnknownError } from "../../db/transientDbRetry.js"
import {
  getZendeskConnection,
  markZendeskConnectionRevoked,
  saveRefreshedZendeskTokens,
  type ZendeskConnection,
} from "../../models/zendesk-connector.js"
import { log } from "../../observability/logger.js"
import {
  refreshZendeskToken,
  ZendeskAuthorizationRevokedError,
} from "./oauth.js"

/**
 * The access token of a caller that lost the refresh race: another caller
 * spent the same refresh token and saved new tokens. Read the row for up
 * to 5 seconds, because the winner saves after its refresh returns.
 */
async function tokenOfRaceWinner(
  orgId: string,
  connection: ZendeskConnection,
  env: Env,
): Promise<string | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await getZendeskConnection(orgId, connection.id, env)
    if (
      current?.accessToken &&
      current.refreshTokenEnc !== connection.refreshTokenEnc
    )
      return current.accessToken
    await new Promise((resolve) => setTimeout(resolve, 500))
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
  // Zendesk spent the old refresh token, so a lost save strands the
  // connection: try again, and log an error when the save does not land.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const saved = await saveRefreshedZendeskTokens({
        orgId,
        connectionId: connection.id,
        env,
        spentRefreshTokenEnc: connection.refreshTokenEnc,
        tokens,
      })
      if (!saved)
        log.error({
          step: "zendesk.tokens.save_lost",
          connectionId: connection.id,
          message: "Another caller saved Zendesk tokens first",
        })
      break
    } catch (error) {
      if (attempt >= 3) {
        log.error({
          step: "zendesk.tokens.save_failed",
          connectionId: connection.id,
          message: formatUnknownError(error),
        })
        break
      }
    }
  }
  return tokens.accessToken
}
