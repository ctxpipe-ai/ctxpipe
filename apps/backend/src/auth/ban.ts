import { APIError } from "better-auth/api"
import { and, eq, inArray, isNull } from "drizzle-orm"

import { type Db, getSystemDb } from "../db/client.js"
import {
  apikeys,
  deviceCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  sessions,
  users,
} from "../db/schema/auth.js"
import { orgApiKeyCreators } from "../db/schema/org_api_key_creators.js"
import { userTokenCutoffs } from "../db/schema/user_token_cutoffs.js"

/*
 * A ban stops every way a user acts. ctxpipe does not load Better Auth's admin
 * plugin (it would add admin routes), so this file does its part with the same
 * fields: `banned`, `banReason` and `banExpires` on the user. Only an operator
 * job sets them (`openworkflow/workflows/admin.ts`).
 *
 * - A ban deletes the sessions of the user, disables the personal API keys and
 *   the organization API keys that the user made, revokes the OAuth tokens,
 *   denies the approved device logins, and refuses each older JWT access
 *   token, in one transaction with the flag.
 * - Better Auth makes a session for each sign-in method, so the session hook
 *   refuses all sign-ins.
 * - `withAuth.ts` and the chat socket refuse a banned user on each request.
 */

type BanFields = { banned?: boolean | null; banExpires?: Date | null }

/** True while the ban holds. A ban whose end date is past holds no more. */
export function isBanned(user: BanFields, now = Date.now()): boolean {
  if (!user.banned) return false
  return !user.banExpires || user.banExpires.getTime() > now
}

const banState = (db: Db, userId: string) =>
  db
    .select({ banned: users.banned, banExpires: users.banExpires })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .then((rows) => rows[0])

/**
 * Better Auth `databaseHooks.session.create.before`, as in the admin plugin:
 * refuse a session to a banned user, and clear a ban whose end date is past.
 */
export async function refuseSessionOfBannedUser(session: {
  userId: string
}): Promise<void> {
  const db = getSystemDb()
  let user = await banState(db, session.userId)
  if (user?.banned && user.banExpires && !isBanned(user)) {
    // Only the ended ban that was read: a new ban stays.
    const cleared = await db
      .update(users)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(
        and(
          eq(users.id, session.userId),
          eq(users.banned, true),
          eq(users.banExpires, user.banExpires),
        ),
      )
      .returning({ id: users.id })
    if (cleared.length === 0) user = await banState(db, session.userId)
    else return
  }
  if (user && isBanned(user))
    throw new APIError("FORBIDDEN", {
      code: "BANNED_USER",
      message:
        "You have been banned from this application. Please contact support if you believe this is an error.",
    })
}

/** The organization API keys that the user made, of one organization or all. */
function orgApiKeysMadeBy(db: Db, userId: string, organizationId?: string) {
  return db
    .select({ id: orgApiKeyCreators.apiKeyId })
    .from(orgApiKeyCreators)
    .innerJoin(apikeys, eq(apikeys.id, orgApiKeyCreators.apiKeyId))
    .where(
      and(
        eq(orgApiKeyCreators.userId, userId),
        eq(apikeys.configId, "organization"),
        organizationId ? eq(apikeys.referenceId, organizationId) : undefined,
      ),
    )
}

/** Disable the organization API keys that the user made. Returns how many. */
export async function disableOrgApiKeysMadeBy(
  db: Db,
  userId: string,
  organizationId?: string,
): Promise<number> {
  const disabled = await db
    .update(apikeys)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        inArray(apikeys.id, orgApiKeysMadeBy(db, userId, organizationId)),
        eq(apikeys.enabled, true),
      ),
    )
    .returning({ id: apikeys.id })
  return disabled.length
}

/** Record who made an organization API key (`org_api_key_creators`). */
export async function recordOrgApiKeyCreator(
  apiKeyId: string,
  userId: string,
): Promise<void> {
  await getSystemDb()
    .insert(orgApiKeyCreators)
    .values({ apiKeyId, userId })
    .onConflictDoNothing()
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
    // Disabled, not deleted: the owners still see the keys. An unban does
    // not enable them again.
    await tx
      .update(apikeys)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(
          eq(apikeys.referenceId, input.userId),
          eq(apikeys.configId, "default"),
        ),
      )
    await disableOrgApiKeysMadeBy(tx, input.userId)
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
    await tx
      .insert(userTokenCutoffs)
      .values({ userId: input.userId, revokedBefore: now })
      .onConflictDoUpdate({
        target: userTokenCutoffs.userId,
        set: { revokedBefore: now },
      })
    return true
  })
}

/**
 * True when a ban revoked the tokens of the user after `issuedAt` (the `iat`
 * of a JWT, in seconds). A token with no `iat` counts as older.
 */
export async function isTokenRevoked(
  userId: string,
  issuedAt: number | undefined,
): Promise<boolean> {
  const [cutoff] = await getSystemDb()
    .select({ revokedBefore: userTokenCutoffs.revokedBefore })
    .from(userTokenCutoffs)
    .where(eq(userTokenCutoffs.userId, userId))
    .limit(1)
  return Boolean(
    cutoff && (issuedAt ?? 0) * 1000 < cutoff.revokedBefore.getTime(),
  )
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
