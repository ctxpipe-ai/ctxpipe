import { createHash } from "node:crypto"

import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { and, eq, inArray, isNull, ne, notInArray } from "drizzle-orm"
import { decodeJwt } from "jose"

import { type Db, getSystemDb } from "../db/client.js"
import {
  accounts,
  apikeys,
  deviceCodes,
  members,
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
 *   clears the tokens of the social providers,
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

/** The fields of a user with no ban. */
const noBan = { banned: false, banReason: null, banExpires: null }

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
      .set(noBan)
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
  if (user && isBanned(user)) throw bannedError()
}

const bannedError = () =>
  new APIError("FORBIDDEN", {
    code: "BANNED_USER",
    message:
      "You have been banned from this application. Please contact support if you believe this is an error.",
  })

/**
 * Better Auth `databaseHooks.session.create.after`, after the commit of the
 * session. A ban can commit between the check of the before hook and the
 * insert: the ban locks the user row, so such an insert waits for the ban,
 * and this check then finds it and deletes the session.
 */
export async function endSessionOfBannedUser(session: {
  id: string
  userId: string
}): Promise<void> {
  const db = getSystemDb()
  const user = await banState(db, session.userId)
  if (!user || !isBanned(user)) return
  await db.delete(sessions).where(eq(sessions.id, session.id))
  throw bannedError()
}

/**
 * True when the user who made the organization API key is banned. A key
 * that no maker is known for gives false.
 */
export async function isOrgApiKeyMakerBanned(
  apiKeyId: string,
): Promise<boolean> {
  const [maker] = await getSystemDb()
    .select({ banned: users.banned, banExpires: users.banExpires })
    .from(orgApiKeyCreators)
    .innerJoin(users, eq(users.id, orgApiKeyCreators.userId))
    .where(eq(orgApiKeyCreators.apiKeyId, apiKeyId))
    .limit(1)
  return Boolean(maker && isBanned(maker))
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

/**
 * Disable the organization API keys of these organizations that have no
 * known maker: the keys made before `org_api_key_creators`. An operator asks
 * for it, because such a key can be the key of a banned or removed user.
 */
export async function disableUnattributedOrgApiKeys(
  db: Db,
  organizationIds: string[],
): Promise<number> {
  if (organizationIds.length === 0) return 0
  const disabled = await db
    .update(apikeys)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(apikeys.configId, "organization"),
        inArray(apikeys.referenceId, organizationIds),
        eq(apikeys.enabled, true),
        notInArray(
          apikeys.id,
          db.select({ id: orgApiKeyCreators.apiKeyId }).from(orgApiKeyCreators),
        ),
      ),
    )
    .returning({ id: apikeys.id })
  return disabled.length
}

/**
 * Record who made an organization API key (`org_api_key_creators`). A ban
 * or a removal of the maker can commit after the key and before this row, so
 * the row commits first, and then a check that waits for a ban or a removal
 * that holds the user or the member rows. A maker that may not act gets no
 * key.
 */
export async function recordOrgApiKeyCreator(input: {
  apiKeyId: string
  userId: string
  organizationId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .insert(orgApiKeyCreators)
    .values({ apiKeyId: input.apiKeyId, userId: input.userId })
    .onConflictDoNothing()
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.organizationId, input.organizationId),
        eq(members.userId, input.userId),
      ),
    )
    .for("share")
  // FOR SHARE waits for a ban that holds the user row (`banUser`).
  const [user] = await db
    .select({ banned: users.banned, banExpires: users.banExpires })
    .from(users)
    .where(eq(users.id, input.userId))
    .for("share")
  if (member && user && !isBanned(user)) return
  await db.delete(apikeys).where(eq(apikeys.id, input.apiKeyId))
  throw bannedError()
}

/**
 * Ban the user and revoke each credential of the user. With
 * `disableUnattributedOrgApiKeys`, also the organization keys with no known
 * maker of each organization of the user. Null: no such user.
 */
export async function banUser(input: {
  userId: string
  reason: string
  expiresAt: Date | null
  disableUnattributedOrgApiKeys?: boolean
}): Promise<{ disabledUnattributedOrgApiKeys: number } | null> {
  return getSystemDb().transaction(async (tx) => {
    const now = new Date()
    // FOR UPDATE conflicts with the key share lock of a session insert, so a
    // sign-in and a ban cannot interleave (`endSessionOfBannedUser`).
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
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
    if (!user) return null
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
    await revokeOAuthTokens(tx, input.userId, now)
    // The tokens that a social provider gave at sign-in: the app acts with
    // them for the user. A sign-in after an unban gives new ones.
    await tx
      .update(accounts)
      .set({
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(accounts.userId, input.userId),
          ne(accounts.providerId, "credential"),
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
    const memberships = input.disableUnattributedOrgApiKeys
      ? await tx
          .select({ id: members.organizationId })
          .from(members)
          .where(eq(members.userId, input.userId))
      : []
    return {
      disabledUnattributedOrgApiKeys: await disableUnattributedOrgApiKeys(
        tx,
        memberships.map((row) => row.id),
      ),
    }
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

/** The claims of a JWT, else undefined (an opaque token). */
function jwtClaims(token: unknown) {
  if (typeof token !== "string" || token.split(".").length !== 3)
    return undefined
  try {
    return decodeJwt(token)
  } catch {
    return undefined
  }
}

/**
 * The `iat` of a JWT, in seconds. A JWT with no readable `iat` gives 0, so
 * a cutoff refuses it. An opaque token (a stored row) gives undefined.
 */
function jwtIssuedAt(token: string | undefined): number | undefined {
  if (!token || token.split(".").length !== 3) return undefined
  return jwtClaims(token)?.iat ?? 0
}

/**
 * The access token of a user info request, as Better Auth reads it: the
 * `Authorization` header (`Bearer`, `DPoP` or no scheme), else
 * `access_token` in a POST body.
 */
function userInfoToken(ctx: {
  headers?: Headers
  body?: unknown
}): string | undefined {
  // A header with no scheme counts too, as in Better Auth.
  const header = /^(?:(?:Bearer|DPoP)\s+)?(\S+)\s*$/i.exec(
    ctx.headers?.get("authorization") ?? "",
  )?.[1]
  if (header) return header
  const body = (ctx.body as Record<string, unknown> | undefined)?.access_token
  return typeof body === "string" ? body : undefined
}

/** The user of an access token that the token endpoint gave. */
async function accessTokenUser(token: unknown): Promise<string | undefined> {
  const claims = jwtClaims(token)
  if (claims) return claims.sub
  if (typeof token !== "string") return undefined
  const [row] = await getSystemDb()
    .select({ userId: oauthAccessTokens.userId })
    .from(oauthAccessTokens)
    .where(
      eq(
        oauthAccessTokens.token,
        createHash("sha256").update(token).digest("base64url"),
      ),
    )
    .limit(1)
  return row?.userId ?? undefined
}

/** Revoke each OAuth access and refresh token of the user. */
async function revokeOAuthTokens(db: Db, userId: string, now: Date) {
  await db
    .update(oauthAccessTokens)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        isNull(oauthAccessTokens.revoked),
      ),
    )
  await db
    .update(oauthRefreshTokens)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthRefreshTokens.userId, userId),
        isNull(oauthRefreshTokens.revoked),
      ),
    )
}

/**
 * Better Auth answers `/oauth2/token`, `/oauth2/userinfo` and
 * `/oauth2/introspect` itself, not through `withAuth.ts`. For a banned user:
 * - the token endpoint revokes the tokens that it just gave and refuses. A
 *   refresh can insert its new token after a ban committed (the insert waits
 *   for the ban's lock of the user row), and this finds it.
 * - the user info is refused and the introspection says `active: false`,
 *   also for a JWT from before a ban.
 */
export function refuseBannedOAuthSubjects(): BetterAuthPlugin {
  return {
    id: "refuse-banned-oauth-subjects",
    hooks: {
      after: [
        {
          matcher: (ctx) =>
            ctx.path === "/oauth2/token" ||
            ctx.path === "/oauth2/userinfo" ||
            ctx.path === "/oauth2/introspect",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned
            if (!returned || typeof returned !== "object") return
            if (returned instanceof Error) return
            const result = returned as Record<string, unknown>
            if (ctx.path === "/oauth2/token") {
              const userId = await accessTokenUser(result.access_token)
              if (!userId) return
              const user = await banState(getSystemDb(), userId)
              if (!user || !isBanned(user)) return
              await getSystemDb().transaction((tx) =>
                revokeOAuthTokens(tx, userId, new Date()),
              )
              throw new APIError("BAD_REQUEST", {
                error: "invalid_grant",
                error_description: "The user is banned",
              })
            }
            const { sub, active, iat } = result
            if (typeof sub !== "string" || active === false) return
            const introspect = ctx.path === "/oauth2/introspect"
            const issuedAt = introspect
              ? typeof iat === "number"
                ? iat
                : undefined
              : jwtIssuedAt(userInfoToken(ctx))
            const user = await banState(getSystemDb(), sub)
            const refused =
              (user && isBanned(user)) ||
              (issuedAt !== undefined && (await isTokenRevoked(sub, issuedAt)))
            if (!refused) return
            if (introspect) return ctx.json({ active: false })
            throw new APIError("UNAUTHORIZED", {
              error: "invalid_token",
              error_description: "The access token was revoked",
            })
          }),
        },
      ],
    },
  }
}

/** End the ban. False: no such user. */
export async function unbanUser(userId: string): Promise<boolean> {
  const [user] = await getSystemDb()
    .update(users)
    .set({ ...noBan, updatedAt: new Date() })
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
