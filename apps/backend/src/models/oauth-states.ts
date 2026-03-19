import { eq } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { oauthStates } from "../db/schema/oauth-states.js"

export async function createOAuthState(data: {
  id: string
  connectorId: string
  orgId: string
  orgSlug: string
}) {
  const db = getSystemDb()
  await db.insert(oauthStates).values(data)
}

/**
 * Atomically retrieves and deletes the state nonce.
 * Returns null if it doesn't exist or is older than 10 minutes.
 */
export async function consumeOAuthState(id: string) {
  const db = getSystemDb()
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)

  const [state] = await db
    .delete(oauthStates)
    .where(eq(oauthStates.id, id))
    .returning()

  if (!state) return null
  if (state.createdAt < thirtyMinutesAgo) return null // expired after 30 minutes

  return state
}
