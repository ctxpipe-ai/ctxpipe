import { describe, expect, it } from "vitest"
import {
  createPagerdutyOAuthState,
  PAGERDUTY_PKCE_COOKIE,
  pagerdutyPkceCookieFromHeader,
  parsePagerdutyPkceCookie,
  serializePagerdutyPkceCookie,
  verifyPagerdutyOAuthState,
} from "./oauth-state.js"

describe("PagerDuty OAuth state", () => {
  const input = {
    authSecret: "pagerduty-oauth-state-secret",
    orgId: "org_1",
    orgSlug: "acme",
    userId: "user_1",
    connectionId: "con_pd",
    now: 1_000,
  }

  it("round-trips signed state with a nonce and optional connection id", () => {
    const { state, nonce } = createPagerdutyOAuthState(input)
    const verified = verifyPagerdutyOAuthState({
      authSecret: input.authSecret,
      state,
      now: input.now + 1,
    })
    expect(verified?.nonce).toBe(nonce)
    expect(verified).toMatchObject({
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      userId: input.userId,
      connectionId: input.connectionId,
    })
    expect(verified).not.toHaveProperty("codeVerifier")
  })

  it("rejects tampered, expired, and wrongly signed state", () => {
    const { state } = createPagerdutyOAuthState(input)
    const [payload, signature] = state.split(".")
    expect(
      verifyPagerdutyOAuthState({
        authSecret: input.authSecret,
        state: `${payload}x.${signature}`,
        now: input.now + 1,
      }),
    ).toBeUndefined()
    expect(
      verifyPagerdutyOAuthState({
        authSecret: input.authSecret,
        state,
        now: input.now + 10 * 60 * 1000,
      }),
    ).toBeUndefined()
    expect(
      verifyPagerdutyOAuthState({
        authSecret: "other-secret",
        state,
        now: input.now + 1,
      }),
    ).toBeUndefined()
  })

  it("rejects state signed for another org when the caller checks orgId", () => {
    const { state } = createPagerdutyOAuthState({
      ...input,
      orgId: "org_other",
    })
    const verified = verifyPagerdutyOAuthState({
      authSecret: input.authSecret,
      state,
      now: input.now + 1,
    })
    expect(verified?.orgId).toBe("org_other")
    expect(verified?.orgId).not.toBe(input.orgId)
  })
})

describe("PagerDuty PKCE cookie", () => {
  it("returns the verifier only when the nonce matches", () => {
    const value = serializePagerdutyPkceCookie({
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
    })
    expect(parsePagerdutyPkceCookie(value, "nonce-1")).toBe("verifier-1")
    expect(parsePagerdutyPkceCookie(value, "other")).toBeUndefined()
    expect(parsePagerdutyPkceCookie(undefined, "nonce-1")).toBeUndefined()
  })

  it("reads the verifier from a Cookie header only for the matching nonce", () => {
    const value = serializePagerdutyPkceCookie({
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
    })
    expect(
      pagerdutyPkceCookieFromHeader(`${PAGERDUTY_PKCE_COOKIE}=${value}`, "nonce-1"),
    ).toBe("verifier-1")
    expect(
      pagerdutyPkceCookieFromHeader(`${PAGERDUTY_PKCE_COOKIE}=${value}`, "other"),
    ).toBeUndefined()
    expect(pagerdutyPkceCookieFromHeader(undefined, "nonce-1")).toBeUndefined()
  })
})
