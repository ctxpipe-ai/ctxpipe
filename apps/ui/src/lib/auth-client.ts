import { apiKeyClient } from "@better-auth/api-key/client"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
// import { passkeyClient } from "@better-auth/passkey/client"
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
