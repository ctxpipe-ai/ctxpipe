import { describe, expect, it } from "vitest"
import {
  decideInviteAccept,
  inviteAcceptPath,
  inviteSignInHref,
  inviteSignOutHref,
} from "./invite-accept-decision"

describe("decideInviteAccept", () => {
  it("shows the join form when nobody is signed in", () => {
    expect(
      decideInviteAccept({
        sessionEmail: null,
        invitationEmail: "member@example.com",
        invitationConfirmed: true,
      }),
    ).toEqual({ kind: "join" })
  })

  it("waits when a session exists but the invite email is still unknown", () => {
    expect(
      decideInviteAccept({
        sessionEmail: "other@example.com",
        invitationEmail: null,
        invitationConfirmed: false,
      }),
    ).toEqual({ kind: "unknown" })
  })

  it("does not auto-accept from an unconfirmed URL email hint", () => {
    expect(
      decideInviteAccept({
        sessionEmail: "member@example.com",
        invitationEmail: "member@example.com",
        invitationConfirmed: false,
      }),
    ).toEqual({ kind: "unknown" })
  })

  it("accepts when the confirmed invitation email matches the session", () => {
    expect(
      decideInviteAccept({
        sessionEmail: "Member@example.com",
        invitationEmail: "member@example.com",
        invitationConfirmed: true,
      }),
    ).toEqual({ kind: "accept" })
  })

  it("blocks auto-accept when the session is a different account", () => {
    expect(
      decideInviteAccept({
        sessionEmail: "other@example.com",
        invitationEmail: "member@example.com",
        invitationConfirmed: true,
      }),
    ).toEqual({
      kind: "wrong-account",
      sessionEmail: "other@example.com",
      invitationEmail: "member@example.com",
    })
  })
})

describe("invite accept links", () => {
  it("builds a same-origin accept path", () => {
    expect(inviteAcceptPath("invitation_1", "member@example.com")).toBe(
      "/.auth/accept-invitation?invitationId=invitation_1&email=member%40example.com",
    )
  })

  it("sends signed-out users through sign-in back to the invite", () => {
    expect(inviteSignInHref("invitation_1", "member@example.com")).toBe(
      "/.auth/sign-in?redirectTo=%2F.auth%2Faccept-invitation%3FinvitationId%3Dinvitation_1%26email%3Dmember%2540example.com",
    )
  })

  it("clears the wrong session then returns to the invite", () => {
    expect(inviteSignOutHref("invitation_1", "member@example.com")).toBe(
      "/.auth/sign-out?redirectTo=%2F.auth%2Faccept-invitation%3FinvitationId%3Dinvitation_1%26email%3Dmember%2540example.com",
    )
  })
})
