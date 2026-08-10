import { describe, expect, it } from "vitest"
import {
  createLinearOAuthState,
  verifyLinearOAuthState,
} from "./oauth-state.js"

describe("Linear OAuth state", () => {
  const input = {
    authSecret: "linear-oauth-state-secret",
    orgId: "org_1",
    orgSlug: "acme",
    userId: "user_1",
    now: 1_000,
  }

  it("round-trips signed state", () => {
    const state = createLinearOAuthState(input)
    expect(
      verifyLinearOAuthState({
        authSecret: input.authSecret,
        state,
        now: input.now + 1,
      }),
    ).toMatchObject({
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      userId: input.userId,
    })
  })

  it("rejects tampered and expired state", () => {
    const state = createLinearOAuthState(input)
    const [payload, signature] = state.split(".")
    expect(
      verifyLinearOAuthState({
        authSecret: input.authSecret,
        state: `${payload}x.${signature}`,
        now: input.now + 1,
      }),
    ).toBeUndefined()
    expect(
      verifyLinearOAuthState({
        authSecret: input.authSecret,
        state,
        now: input.now + 10 * 60 * 1000,
      }),
    ).toBeUndefined()
  })
})
