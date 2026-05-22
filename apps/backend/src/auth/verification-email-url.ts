const VERIFY_PATH = "/.auth/api/v1/auth/verify-email"

/**
 * Better Auth may provide verification URLs rooted at `/<verify-email>` while
 * this app serves auth endpoints under `/.auth/api/v1/auth`. Normalise to the
 * mounted verify-email endpoint so links in outbound emails always resolve.
 */
export function resolveEmailVerificationUrl(
  authBaseUrl: string,
  urlFromBetterAuth: string,
): string {
  try {
    const incoming = new URL(urlFromBetterAuth)
    const token = incoming.searchParams.get("token")
    if (!token) return urlFromBetterAuth

    const base = authBaseUrl.endsWith("/") ? authBaseUrl : `${authBaseUrl}/`
    const origin = new URL(base).origin
    const callbackURL = incoming.searchParams.get("callbackURL") ?? "/"

    const verifyUrl = new URL(VERIFY_PATH, origin)
    verifyUrl.searchParams.set("token", token)
    verifyUrl.searchParams.set("callbackURL", callbackURL)
    return verifyUrl.toString()
  } catch {
    return urlFromBetterAuth
  }
}
