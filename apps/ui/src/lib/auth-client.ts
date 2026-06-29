import { apiKeyClient } from "@better-auth/api-key/client"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
// import { passkeyClient } from "@better-auth/passkey/client"
import {
  deviceAuthorizationClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { onAuthClientOrganizationCreateSuccess } from "@/lib/organization-create-redirect"

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
  fetchOptions: {
    onSuccess: (context) => {
      void onAuthClientOrganizationCreateSuccess(context)
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
