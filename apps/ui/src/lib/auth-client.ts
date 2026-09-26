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
      const twoFactorRedirect =
        !!context.data &&
        typeof context.data === "object" &&
        "twoFactorRedirect" in context.data &&
        Boolean(context.data.twoFactorRedirect)
      const completedSignIn =
        (path.endsWith("/sign-in/email") && !twoFactorRedirect) ||
        path.endsWith("/two-factor/verify-totp") ||
        path.endsWith("/two-factor/verify-otp")
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

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
  useListOrganizations,
} = authClient
