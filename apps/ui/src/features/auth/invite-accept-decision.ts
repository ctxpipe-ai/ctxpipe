export type InviteAcceptDecision =
  | { kind: "join" }
  | { kind: "unknown" }
  | { kind: "accept" }
  | {
      kind: "wrong-account"
      sessionEmail: string
      invitationEmail: string
    }

function emailsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

export function decideInviteAccept(input: {
  sessionEmail: string | null | undefined
  invitationEmail: string | null | undefined
  invitationConfirmed: boolean
}): InviteAcceptDecision {
  const sessionEmail = input.sessionEmail?.trim() || null
  const invitationEmail = input.invitationEmail?.trim() || null

  if (!sessionEmail) return { kind: "join" }
  if (!invitationEmail) return { kind: "unknown" }
  if (!emailsMatch(sessionEmail, invitationEmail)) {
    return {
      kind: "wrong-account",
      sessionEmail,
      invitationEmail,
    }
  }
  if (!input.invitationConfirmed) return { kind: "unknown" }
  return { kind: "accept" }
}

export function inviteAcceptPath(
  invitationId: string,
  email?: string | null,
): string {
  const params = new URLSearchParams({ invitationId })
  if (email) params.set("email", email)
  return `/.auth/accept-invitation?${params.toString()}`
}

export function inviteSignInHref(
  invitationId: string,
  email?: string | null,
): string {
  return `/.auth/sign-in?redirectTo=${encodeURIComponent(
    inviteAcceptPath(invitationId, email),
  )}`
}

export function inviteSignOutHref(
  invitationId: string,
  email?: string | null,
): string {
  return `/.auth/sign-out?redirectTo=${encodeURIComponent(
    inviteAcceptPath(invitationId, email),
  )}`
}
