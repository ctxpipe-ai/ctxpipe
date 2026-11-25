import { APIError } from "better-auth/api"
import { and, eq, isNull } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import {
  apikeys,
  deviceCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  sessions,
  users,
} from "../db/schema/auth.js"

/*
 * A ban stops every way a user acts. ctxpipe does not load Better Auth's admin
 * plugin (it would add admin routes), so this file does its part with the same
 * fields: `banned`, `banReason` and `banExpires` on the user. Only an operator
 * job sets them (`openworkflow/workflows/admin.ts`).
 *
 * - A ban deletes the sessions of the user, disables the personal API keys,
 *   revokes the OAuth tokens, and denies the approved device logins, in one
 *   transaction with the flag.
 * - Better Auth makes a session for each sign-in method, so the session hook
 *   refuses all sign-ins.
 * - `withAuth.ts` refuses each credential of a banned user on each request.
 *   That also stops a JWT access token, which no revocation can stop.
 */

type BanFields = { banned?: boolean | null; banExpires?: Date | null }

/** True while the ban holds. A ban whose end date is past holds no more. */
export function isBanned(user: BanFields, now = Date.now()): boolean {
  if (!user.banned) return false
  return !user.banExpires || user.banExpires.getTime() > now
}

/**
 * Better Auth `databaseHooks.session.create.before`, as in the admin plugin:
 * refuse a session to a banned user, and clear a ban whose end date is past.
 */
export async function refuseSessionOfBannedUser(session: {
  userId: string
}): Promise<void> {
  const db = getSystemDb()
  const [user] = await db
    .select({ banned: users.banned, banExpires: users.banExpires })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)
  if (!user?.banned) return
  if (isBanned(user)) {
    throw new APIError("FORBIDDEN", {
      code: "BANNED_USER",
      message:
        "You have been banned from this application. Please contact support if you believe this is an error.",
    })
  }
  await db
    .update(users)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(eq(users.id, session.userId))
}

/** Ban the user and revoke each credential of the user. False: no such user. */
export async function banUser(input: {
  userId: string
  reason: string
  expiresAt: Date | null
}): Promise<boolean> {
  return getSystemDb().transaction(async (tx) => {
    const now = new Date()
    const [user] = await tx
      .update(users)
      .set({
        banned: true,
        banReason: input.reason,
        banExpires: input.expiresAt,
        updatedAt: now,
      })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id })
    if (!user) return false
    await tx.delete(sessions).where(eq(sessions.userId, input.userId))
    // Disabled, not deleted: the owner still sees the keys. An unban does not
    // enable them again.
    await tx
      .update(apikeys)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(
          eq(apikeys.referenceId, input.userId),
          eq(apikeys.configId, "default"),
        ),
      )
    await tx
      .update(oauthAccessTokens)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthAccessTokens.userId, input.userId),
          isNull(oauthAccessTokens.revoked),
        ),
      )
    await tx
      .update(oauthRefreshTokens)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthRefreshTokens.userId, input.userId),
          isNull(oauthRefreshTokens.revoked),
        ),
      )
    await tx
      .update(deviceCodes)
      .set({ status: "denied" })
      .where(eq(deviceCodes.userId, input.userId))
    return true
  })
}

/** End the ban. False: no such user. */
export async function unbanUser(userId: string): Promise<boolean> {
  const [user] = await getSystemDb()
    .update(users)
    .set({
      banned: false,
      banReason: null,
      banExpires: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id })
  return Boolean(user)
}

/** Delete each session of the user, as the admin plugin's revoke does. */
export async function revokeUserSessions(userId: string): Promise<number> {
  const deleted = await getSystemDb()
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id })
  return deleted.length
}
