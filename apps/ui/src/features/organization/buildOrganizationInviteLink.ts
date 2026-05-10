/**
 * Matches `sendInvitationEmail` in `apps/backend/src/auth/config.ts`: sign-up URL
 * with `redirectTo` pointing at accept-invitation for the given invitation id and email.
 */
export function buildOrganizationInviteLink(options: {
  origin: string
  invitationId: string
  email: string
}): string {
  const base = options.origin.replace(/\/$/, "")
  const acceptPath = `/.auth/accept-invitation?invitationId=${encodeURIComponent(options.invitationId)}`
  const redirectTo = `${acceptPath}&email=${encodeURIComponent(options.email)}`
  return `${base}/.auth/sign-up?redirectTo=${encodeURIComponent(redirectTo)}`
}
