import { expireCookie } from "better-auth/cookies"
import { setTokenUtil } from "better-auth/oauth2"
import type { Context } from "hono"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { pendingAccounts } from "../db/schema/pending_accounts.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"
import { getAuth } from "./config.js"

const PENDING_TTL_MIN = 15

type OAuthStatePayload = {
  callbackURL: string
  codeVerifier: string
  errorURL?: string
  expiresAt: number
  link?: { email: string; userId: string }
}

function withErrorQuery(
  target: string,
  error: string,
  errorDescription?: string | null,
): string {
  const pathPart = target.split("?")[0] ?? target
  const rawQuery = target.includes("?")
    ? target.split("?").slice(1).join("?")
    : ""
  const sp = new URLSearchParams(rawQuery)
  sp.set("error", error)
  if (errorDescription) sp.set("error_description", errorDescription)
  const q = sp.toString()
  return q ? `${pathPart}?${q}` : pathPart
}

function withExtraQuery(target: string, extra: Record<string, string>): string {
  const pathPart = target.split("?")[0] ?? target
  const rawQuery = target.includes("?")
    ? target.split("?").slice(1).join("?")
    : ""
  const sp = new URLSearchParams(rawQuery)
  for (const [k, v] of Object.entries(extra)) sp.set(k, v)
  const q = sp.toString()
  return q ? `${pathPart}?${q}` : pathPart
}

function atlassianRedirectUri(): string {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return `${env.AUTH_BASE_URL.replace(/\/$/, "")}/.auth/api/v1/auth/callback/atlassian`
}

/**
 * Atlassian **link** OAuth callback: when the account is already bound to another user,
 * stage `pending_accounts` and redirect with `pendingAccountClaim=…`. All non-link and other
 * provider flows delegate to the stock Better Auth handler.
 */
export async function atlassianLinkCallbackFirst(c: Context) {
  if (c.req.method !== "GET") {
    return getAuth().handler(c.req.raw)
  }

  const auth = getAuth()
  const request = c.req.raw
  const sp = new URL(request.url).searchParams
  const stateQ = sp.get("state")
  if (!stateQ) {
    return auth.handler(request)
  }

  const bCtx = await auth.$context
  const onApiErr = bCtx.options as {
    onAPIError?: { errorURL?: string }
  }
  const defaultErrorPath = onApiErr.onAPIError?.errorURL
    ? String(onApiErr.onAPIError.errorURL)
    : `${String(bCtx.baseURL).replace(/\/$/, "")}/error`
  const ctxForTokens = bCtx as never

  const setCookieLines: string[] = []
  const setCookie: (
    name: string,
    value: string,
    attrs: {
      path?: string
      maxAge?: number
      httpOnly?: boolean
      sameSite?: string
      secure?: boolean
    },
  ) => void = (name, value, attrs) => {
    const segs: string[] = []
    if (value === "") segs.push(`${name}=`)
    else segs.push(`${name}=${value}`)
    if (attrs.path != null) segs.push(`Path=${attrs.path}`)
    if (attrs.maxAge != null) segs.push(`Max-Age=${String(attrs.maxAge)}`)
    if (attrs.httpOnly) segs.push("HttpOnly")
    if (attrs.sameSite) segs.push(`SameSite=${attrs.sameSite}`)
    if (attrs.secure) segs.push("Secure")
    setCookieLines.push(segs.join("; "))
  }

  const redirect302 = (location: string) => {
    const h = new Headers({ Location: location })
    for (const line of setCookieLines) h.append("Set-Cookie", line)
    return new Response(null, { status: 302, headers: h })
  }

  const expireStateCookie = () => {
    const stateCookie = bCtx.createAuthCookie("state", { maxAge: 300 })
    expireCookie({ setCookie } as never, stateCookie)
  }

  const v = await bCtx.internalAdapter.findVerificationValue(stateQ)
  if (!v) {
    return auth.handler(request)
  }

  let data: OAuthStatePayload
  try {
    const parsed: unknown = JSON.parse(v.value)
    if (typeof parsed !== "object" || !parsed) throw new Error("empty")
    data = parsed as OAuthStatePayload
  } catch (e) {
    log.info({
      step: "atlassian-callback",
      message: "invalid verification payload",
      error: e instanceof Error ? e.message : String(e),
    })
    return auth.handler(request)
  }

  if (!data.link) {
    return auth.handler(request)
  }

  const codeQ = sp.get("code")
  const errQ = sp.get("error")
  const errDesc = sp.get("error_description")
  const errorBase = data.errorURL ?? defaultErrorPath
  const link = data.link
  const accountOpts = bCtx.options.account as {
    accountLinking?: { allowDifferentEmails?: boolean }
  }

  if (errQ) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, errQ, errDesc))
  }
  if (!codeQ) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "no_code"))
  }
  if (data.expiresAt < Date.now()) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "please_restart_the_process"))
  }

  const provider = bCtx.socialProviders.find((p) => p.id === "atlassian")
  if (!provider) {
    log.info({
      step: "atlassian-callback",
      message: "atlassian provider missing",
    })
    return auth.handler(request)
  }

  let tokens: Awaited<ReturnType<typeof provider.validateAuthorizationCode>>
  try {
    tokens = await provider.validateAuthorizationCode({
      code: codeQ,
      codeVerifier: data.codeVerifier,
      redirectURI: atlassianRedirectUri(),
    })
  } catch (e) {
    log.info({
      step: "atlassian-callback",
      message: "code exchange failed",
      error: e instanceof Error ? e.message : String(e),
    })
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "invalid_code"))
  }
  if (!tokens) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "invalid_code"))
  }

  const userInfo = await provider
    .getUserInfo({ ...tokens, user: undefined })
    .then((r) => r?.user)
  if (!userInfo) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "unable_to_get_user_info"))
  }

  if (!bCtx.trustedProviders.includes("atlassian") && !userInfo.emailVerified) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "unable_to_link_account"))
  }

  if (
    userInfo.email &&
    userInfo.email.toLowerCase() !== link.email.toLowerCase() &&
    accountOpts.accountLinking?.allowDifferentEmails !== true
  ) {
    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(withErrorQuery(errorBase, "email_doesn't_match"))
  }

  const existing = await bCtx.internalAdapter.findAccount(String(userInfo.id))

  if (existing && existing.userId.toString() !== link.userId.toString()) {
    // No org in this OAuth callback (only `userId` in link state) — not under withNetworkOrgContext.
    // Prefer getOrgDb + withOrgDbContext if we ever thread organizationId into link state.
    const db = getSystemDb()
    const id = generateObjectId("pend")
    const expires = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000)
    const accessT = await setTokenUtil(tokens.accessToken, ctxForTokens)
    const refreshT = await setTokenUtil(tokens.refreshToken, ctxForTokens)
    const scope = tokens.scopes?.join(",")
    try {
      await db.insert(pendingAccounts).values({
        id,
        accountId: String(userInfo.id),
        providerId: "atlassian",
        userId: link.userId,
        accessToken: accessT,
        refreshToken: refreshT,
        idToken: tokens.idToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt
          ? new Date(tokens.accessTokenExpiresAt)
          : undefined,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt
          ? new Date(tokens.refreshTokenExpiresAt)
          : undefined,
        scope,
        password: null,
        expiresAt: expires,
        conflictingAccountId: existing.id,
      })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      log.error({
        step: "atlassian-callback",
        message: "pending_accounts insert failed",
        error: err.message,
      })
      await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
      setCookieLines.length = 0
      expireStateCookie()
      return redirect302(
        withErrorQuery(errorBase, "account_already_linked_to_different_user"),
      )
    }

    await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
    setCookieLines.length = 0
    expireStateCookie()
    return redirect302(
      withExtraQuery(data.errorURL ?? data.callbackURL, {
        pendingAccountClaim: id,
      }),
    )
  }

  if (existing) {
    const updateData = Object.fromEntries(
      Object.entries({
        accessToken: await setTokenUtil(tokens.accessToken, ctxForTokens),
        refreshToken: await setTokenUtil(tokens.refreshToken, ctxForTokens),
        idToken: tokens.idToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        scope: tokens.scopes?.join(","),
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, unknown>
    const okU = await bCtx.internalAdapter.updateAccount(
      existing.id,
      updateData,
    )
    if (!okU) {
      await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
      setCookieLines.length = 0
      expireStateCookie()
      return redirect302(withErrorQuery(errorBase, "unable_to_link_account"))
    }
  } else {
    const created = await bCtx.internalAdapter.createAccount({
      userId: link.userId,
      providerId: "atlassian",
      accountId: String(userInfo.id),
      ...tokens,
      accessToken: await setTokenUtil(tokens.accessToken, ctxForTokens),
      refreshToken: await setTokenUtil(tokens.refreshToken, ctxForTokens),
      scope: tokens.scopes?.join(","),
    } as never)
    if (!created) {
      await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
      setCookieLines.length = 0
      expireStateCookie()
      return redirect302(withErrorQuery(errorBase, "unable_to_link_account"))
    }
  }

  await bCtx.internalAdapter.deleteVerificationByIdentifier(stateQ)
  setCookieLines.length = 0
  expireStateCookie()
  return redirect302(data.callbackURL)
}
