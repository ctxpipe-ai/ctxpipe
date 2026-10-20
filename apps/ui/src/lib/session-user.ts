/**
 * The session user fields that the app reads. Better Auth parses date
 * strings, so `onboardingCompletedAt` can be a `Date` on the client.
 */
type SessionUser = {
  id: string
  email?: string | null
  onboardingCompletedAt?: Date | string | null
}

export function sessionUser(
  session: { user?: unknown } | null | undefined,
): SessionUser | null {
  const user = session?.user as SessionUser | undefined
  return user?.id ? user : null
}

/** Owner and admin can invite and connect. A role can list several roles. */
export function isAdminRole(role: string | null | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "owner" || part === "admin")
}
