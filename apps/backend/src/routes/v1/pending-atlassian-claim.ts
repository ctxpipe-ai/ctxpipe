import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { getOrgDb } from "../../db/client.js"
import { accounts } from "../../db/schema/auth.js"
import { pendingAccounts } from "../../db/schema/pending_accounts.js"
import { generateObjectId } from "../../lib/id.js"
import { getLogger } from "../../observability/logger.js"

const postConfirm = createRoute({
  method: "post",
  path: "/{pendingId}/confirm",
  request: {
    params: z.object({ pendingId: z.string() }),
  },
  responses: {
    200: { description: "Atlassian account linked to the current user" },
    400: { description: "Bad request" },
    401: { description: "Unauthorized" },
    404: { description: "Not found" },
  },
})

const postCancel = createRoute({
  method: "post",
  path: "/{pendingId}/cancel",
  request: {
    params: z.object({ pendingId: z.string() }),
  },
  responses: {
    200: { description: "Pending claim removed" },
    401: { description: "Unauthorized" },
    404: { description: "Not found" },
  },
})

export const pendingAtlassianClaimRoutes = new OpenAPIHono<AppEnv>()
  .openapi(postConfirm, async (c) => {
    const log = getLogger()
    const pendingId = c.req.param("pendingId")
    const user = c.var.user
    if (!user) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const db = getOrgDb()

    const [row] = await db
      .select()
      .from(pendingAccounts)
      .where(
        and(
          eq(pendingAccounts.id, pendingId),
          eq(pendingAccounts.userId, user.id),
        ),
      )
      .limit(1)

    if (!row) {
      return c.json(
        { error: "not_found", message: "Pending claim not found" },
        404,
      )
    }
    if (row.expiresAt < new Date()) {
      await db.delete(pendingAccounts).where(eq(pendingAccounts.id, pendingId))
      return c.json(
        { error: "expired", message: "This claim has expired" },
        400,
      )
    }
    if (row.providerId !== "atlassian") {
      return c.json(
        { error: "invalid", message: "Unsupported pending provider" },
        400,
      )
    }

    const [conflict] = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, row.conflictingAccountId),
          eq(accounts.accountId, row.accountId),
          eq(accounts.providerId, "atlassian"),
        ),
      )
      .limit(1)
    if (!conflict) {
      log.warn("pending_atlassian_claim_stale", {
        pendingId,
        conflictingId: row.conflictingAccountId,
      })
      await db.delete(pendingAccounts).where(eq(pendingAccounts.id, pendingId))
      return c.json(
        {
          error: "stale",
          message: "The conflicting link changed; start again",
        },
        400,
      )
    }
    if (conflict.userId === user.id) {
      await db.delete(pendingAccounts).where(eq(pendingAccounts.id, pendingId))
      return c.json({ error: "invalid", message: "Already linked" }, 400)
    }

    const newId = generateObjectId("acct")

    await db
      .delete(accounts)
      .where(
        and(
          eq(accounts.id, row.conflictingAccountId),
          eq(accounts.userId, conflict.userId),
        ),
      )
    await db.insert(accounts).values({
      id: newId,
      accountId: row.accountId,
      providerId: "atlassian",
      userId: user.id,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      idToken: row.idToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
      scope: row.scope,
      password: row.password,
    })
    await db.delete(pendingAccounts).where(eq(pendingAccounts.id, pendingId))

    return c.json({ ok: true } as const, 200)
  })
  .openapi(postCancel, async (c) => {
    const pendingId = c.req.param("pendingId")
    const user = c.var.user
    if (!user) {
      return c.json({ error: "unauthorized" }, 401)
    }
    const db = getOrgDb()
    const r = await db
      .delete(pendingAccounts)
      .where(
        and(
          eq(pendingAccounts.id, pendingId),
          eq(pendingAccounts.userId, user.id),
        ),
      )
      .returning({ id: pendingAccounts.id })
    if (r.length === 0) {
      return c.json({ error: "not_found" }, 404)
    }
    return c.json({ ok: true } as const, 200)
  })
