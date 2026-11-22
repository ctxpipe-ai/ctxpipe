import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { useMswServer } from "../../test/msw.js"
import { getSystemDb } from "../db/client.js"
import { accounts, users } from "../db/schema/auth.js"
import { pendingAccounts } from "../db/schema/pending_accounts.js"
import { atlassianLinkCallbackFirst } from "./atlassian-link-callback.js"
import { getAuth } from "./config.js"

// A user links an Atlassian account that another user already linked. The
// link callback of ctxpipe stages the account in `pending_accounts` and sends
// the user back with a claim id, so the user can take the account over.

const base = "http://localhost:3000"
const authPath = `${base}/.auth/api/v1/auth`
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const atlassianAccountId = `atl-${suffix}`

let linkingEmail = ""
useMswServer(
  http.post("https://auth.atlassian.com/oauth/token", () =>
    HttpResponse.json({
      access_token: "atlassian-access",
      refresh_token: "atlassian-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read:me offline_access",
    }),
  ),
  http.get("https://api.atlassian.com/me", () =>
    HttpResponse.json({
      account_id: atlassianAccountId,
      email: linkingEmail,
      name: "Atlassian link test",
      picture: null,
    }),
  ),
)

const app = new Hono()
app.get("/.auth/api/v1/auth/callback/atlassian", (c) =>
  atlassianLinkCallbackFirst(c),
)

function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((part) => part.split(";")[0] ?? "")
}

describe("Atlassian link callback (Postgres)", () => {
  let linking: SeededOrg
  const ownerId = `user_atlassian_owner_${suffix}`

  beforeAll(async () => {
    // Better Auth reads the Atlassian sign-in config when seedOrg creates the
    // auth instance, so set the env before that.
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("ATLASSIAN_CLIENT_ID", "atlassian-client")
    vi.stubEnv("ATLASSIAN_CLIENT_SECRET", "atlassian-client-secret")
    linking = await seedOrg()
    linkingEmail = linking.email
    const db = getSystemDb()
    await db.insert(users).values({
      id: ownerId,
      name: "Atlassian owner",
      email: `atlassian-owner-${suffix}@example.com`,
      emailVerified: true,
    })
    await db.insert(accounts).values({
      id: `acc_atlassian_${suffix}`,
      accountId: atlassianAccountId,
      providerId: "atlassian",
      userId: ownerId,
    })
  })

  afterAll(async () => {
    await getSystemDb().delete(users).where(eq(users.id, ownerId))
    await cleanupSeededOrg(linking)
    vi.unstubAllEnvs()
  })

  it("stages an account that another user linked and returns a claim id", async () => {
    const started = await getAuth().handler(
      new Request(`${authPath}/link-social`, {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          cookie: linking.cookie,
        },
        body: JSON.stringify({
          provider: "atlassian",
          callbackURL: `${base}/settings`,
        }),
      }),
    )
    expect(started.status).toBe(200)
    const { url } = (await started.json()) as { url: string }
    const state = new URL(url).searchParams.get("state") ?? ""
    const cookie = [linking.cookie, ...cookiePairs(started)].join("; ")

    const res = await app.request(
      `${authPath}/callback/atlassian?${new URLSearchParams({ code: "atlassian-code", state })}`,
      { headers: { cookie } },
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location") ?? "", base)
    expect(location.pathname).toBe("/settings")
    const claimId = location.searchParams.get("pendingAccountClaim")
    expect(claimId).toBeTruthy()
    const [pending] = await getSystemDb()
      .select()
      .from(pendingAccounts)
      .where(
        and(
          eq(pendingAccounts.id, claimId ?? ""),
          eq(pendingAccounts.userId, linking.userId),
        ),
      )
    expect(pending).toMatchObject({
      accountId: atlassianAccountId,
      providerId: "atlassian",
      conflictingAccountId: `acc_atlassian_${suffix}`,
    })
  })
})
