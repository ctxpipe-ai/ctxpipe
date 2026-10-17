import { apiKeyClient } from "@better-auth/api-key/client"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
// import { passkeyClient } from "@better-auth/passkey/client"
import HyperDX from "@hyperdx/browser"
import {
  deviceAuthorizationClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

function authApiBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin
  const fromEnv = import.meta.env.VITE_PUBLIC_API_URL
  if (typeof fromEnv === "string" && fromEnv.length > 0)
    return fromEnv.replace(/\/$/, "")
  return "http://localhost:3000"
}

/** Session atom still has the pre-request value inside fetch `onSuccess`. */
let signedInBeforeRequest = (): boolean => false

export const authClient = createAuthClient({
  baseURL: authApiBaseUrl(),
  basePath: "/.auth/api/v1/auth",
  // Better Auth captures `fetch` at client creation, before HyperDX patches it.
  // A wrapper calls the current global fetch so auth requests carry traceparent.
  fetchOptions: {
    customFetchImpl: (input, init) => globalThis.fetch(input, init),
    onSuccess(context) {
      const requestUrl = context.request.url
      const href =
        requestUrl instanceof URL
          ? requestUrl.href
          : typeof requestUrl === "string"
            ? requestUrl
            : ""
      let path = ""
      try {
        path = new URL(href).pathname
      } catch {
        return
      }
      if (signedInBeforeRequest()) return
      const twoFactorRedirect =
        !!context.data &&
        typeof context.data === "object" &&
        "twoFactorRedirect" in context.data &&
        Boolean(context.data.twoFactorRedirect)
      // Social sign-in finishes on a redirect, not these JSON endpoints.
      const completedSignIn =
        (path.endsWith("/sign-in/email") && !twoFactorRedirect) ||
        path.endsWith("/two-factor/verify-totp") ||
        path.endsWith("/two-factor/verify-otp") ||
        path.endsWith("/two-factor/verify-backup-code")
      if (completedSignIn) HyperDX.addAction("sign_in")
    },
  },
  plugins: [
    apiKeyClient(),
    organizationClient(),
    twoFactorClient(),
    deviceAuthorizationClient(),
    // passkeyClient(),
    oauthProviderClient(),
  ],
})

signedInBeforeRequest = () => {
  const data = authClient.$store.atoms.session.get()?.data as
    | { user?: { id?: string | null } | null }
    | null
    | undefined
  return Boolean(data?.user?.id)
}

/**
 * Fetch the session into the `useSession` atom, then tell if onboarding is
 * complete. Pages such as `/` read this atom, so a stale atom sends the user
 * back to onboarding. `getSession` does not update the atom, and `refetch`
 * does not reject on a failed request.
 */
export async function refetchSessionOnboardingComplete(): Promise<boolean> {
  const session = authClient.$store.atoms.session
  await session.get().refetch()
  const data = session.get().data as
    | { user?: { onboardingCompletedAt?: string | null } | null }
    | null
    | undefined
  return Boolean(data?.user?.onboardingCompletedAt)
}

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
  useListOrganizations,
} = authClient
