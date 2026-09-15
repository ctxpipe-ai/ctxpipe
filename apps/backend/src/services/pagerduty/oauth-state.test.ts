import { describe, expect, it } from "vitest"
import {
  createPagerdutyOAuthState,
  verifyPagerdutyOAuthState,
} from "./oauth-state.js"

describe("PagerDuty OAuth state", () => {
  const input = {
    authSecret: "pagerduty-oauth-state-secret",
    orgId: "org_1",
    orgSlug: "acme",
    userId: "user_1",
    codeVerifier: "verifier-1",
    now: 1_000,
  }

  it("round-trips signed state with a nonce and PKCE verifier", () => {
    const state = createPagerdutyOAuthState(input)
    const verified = verifyPagerdutyOAuthState({
      authSecret: input.authSecret,
      state,
      now: input.now + 1,
    })
    expect(verified).toMatchObject({
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      userId: input.userId,
      codeVerifier: input.codeVerifier,
    })
    expect(verified?.nonce).toEqual(expect.any(String))
  })

  it("rejects tampered, expired, and wrong-org-unrelated forged state", () => {
    const state = createPagerdutyOAuthState(input)
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
})
