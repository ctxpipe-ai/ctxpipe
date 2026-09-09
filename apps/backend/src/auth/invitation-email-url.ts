export function invitationEmailLink(
  authBaseUrl: string,
  invitationId: string,
  email: string,
): string {
  const base = authBaseUrl.replace(/\/$/, "")
  const params = new URLSearchParams({
    invitationId,
    email,
  })
  return `${base}/.auth/accept-invitation?${params.toString()}`
}
