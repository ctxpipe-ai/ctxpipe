import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { apiFetch, readApiJson } from "@/lib/api-result"

import { inviteAcceptError } from "./invite-accept-error"

const base = "http://localhost:3000"
const authBase = `${base}/.auth/api/v1/auth`
const server = setupServer()

// The page's client: same base path and plugin, and the same `throw: true`.
const authClient = createAuthClient({
  baseURL: base,
  basePath: "/.auth/api/v1/auth",
  fetchOptions: {
    customFetchImpl: (input, init) => globalThis.fetch(input, init),
  },
  plugins: [organizationClient()],
})

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error("expected the request to fail")
}

function signUp() {
  return authClient.signUp.email({
    email: "member@example.com",
    password: "password-1234",
    name: "Member",
    fetchOptions: { throw: true },
  })
}

function acceptInvitation() {
  return authClient.organization.acceptInvitation({
    invitationId: "invitation_1",
    fetchOptions: { throw: true },
  })
}

async function readPublicInvitation() {
  const res = await apiFetch(
    `${base}/.auth/api/v1/public/invitations/invitation_1`,
  )
  return readApiJson(res, { message: "Invitation not found or expired" })
}

describe("inviteAcceptError (CTX-867)", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it("tells the invitee to sign in when the email already has an account", async () => {
    // Better Auth's answer when email verification is off (PR previews).
    server.use(
      http.post(`${authBase}/sign-up/email`, () =>
        HttpResponse.json(
          {
            code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
            message: "User already exists. Use another email.",
          },
          { status: 422 },
        ),
      ),
    )

    expect(inviteAcceptError(await failureOf(signUp))).toEqual({
      kind: "account-exists",
    })
  })

  it("does not offer a retry for another refusal, such as a full organization", async () => {
    server.use(
      http.post(`${authBase}/organization/accept-invitation`, () =>
        HttpResponse.json(
          {
            code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
            message: "Organization membership limit reached",
          },
          { status: 403 },
        ),
      ),
      http.post(`${authBase}/sign-up/email`, () =>
        HttpResponse.json(
          { code: "PASSWORD_TOO_LONG", message: "Password too long" },
          { status: 400 },
        ),
      ),
    )

    expect(inviteAcceptError(await failureOf(acceptInvitation))).toEqual({
      kind: "refused",
    })
    expect(inviteAcceptError(await failureOf(signUp))).toEqual({
      kind: "refused",
    })
  })

  it("says the invitation is not available when it expired, was used, or was canceled", async () => {
    server.use(
      http.post(`${authBase}/organization/accept-invitation`, () =>
        HttpResponse.json(
          { code: "INVITATION_NOT_FOUND", message: "Invitation not found" },
          { status: 400 },
        ),
      ),
      http.get(`${base}/.auth/api/v1/public/invitations/:id`, () =>
        HttpResponse.json(
          { error: "Invitation not found or expired" },
          { status: 404 },
        ),
      ),
    )

    expect(inviteAcceptError(await failureOf(acceptInvitation))).toEqual({
      kind: "invitation-unavailable",
    })
    expect(inviteAcceptError(await failureOf(readPublicInvitation))).toEqual({
      kind: "invitation-unavailable",
    })
  })

  it("says the invitation is for another email when the signed-in account is not the recipient", async () => {
    server.use(
      http.post(`${authBase}/organization/accept-invitation`, () =>
        HttpResponse.json(
          {
            code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
            message: "You are not the recipient of the invitation",
          },
          { status: 403 },
        ),
      ),
    )

    expect(inviteAcceptError(await failureOf(acceptInvitation))).toEqual({
      kind: "wrong-recipient",
    })
  })

  it("offers a retry for a server error or a lost connection", async () => {
    server.use(
      http.post(`${authBase}/sign-up/email`, () =>
        HttpResponse.json(
          { code: "FAILED_TO_CREATE_USER", message: "Failed to create user" },
          { status: 500 },
        ),
      ),
      http.post(`${authBase}/organization/accept-invitation`, () =>
        HttpResponse.error(),
      ),
      http.get(`${base}/.auth/api/v1/public/invitations/:id`, () =>
        HttpResponse.error(),
      ),
    )

    expect(inviteAcceptError(await failureOf(signUp))).toEqual({
      kind: "failed",
    })
    expect(inviteAcceptError(await failureOf(acceptInvitation))).toEqual({
      kind: "failed",
    })
    expect(inviteAcceptError(await failureOf(readPublicInvitation))).toEqual({
      kind: "failed",
    })
  })
})
