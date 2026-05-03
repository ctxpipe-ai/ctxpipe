import { apiKeyClient } from "@better-auth/api-key/client"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
// import { passkeyClient } from "@better-auth/passkey/client"
import { organizationClient, twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { defaultApiKeyPermissions } from "./apiKeyPermissions"

function authApiBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin
  const fromEnv = import.meta.env.VITE_PUBLIC_API_URL
  if (typeof fromEnv === "string" && fromEnv.length > 0)
    return fromEnv.replace(/\/$/, "")
  return "http://localhost:3000"
}

const baseAuthClient = createAuthClient({
  baseURL: authApiBaseUrl(),
  basePath: "/.auth/api/v1/auth",
  plugins: [
    organizationClient(),
    twoFactorClient(),
    apiKeyClient(),
    // passkeyClient(),
    oauthProviderClient(),
  ],
})

type ApiKeyCreateOpts = Parameters<
  (typeof baseAuthClient)["apiKey"]["create"]
>[0]

/** Ensures API keys carry full REST+MCP scopes and correct user vs org configId. */
export const authClient = Object.assign(baseAuthClient, {
  apiKey: {
    ...baseAuthClient.apiKey,
    create: async (opts: ApiKeyCreateOpts) => {
      const orgScoped =
        opts.organizationId !== undefined &&
        opts.organizationId !== "" &&
        opts.organizationId !== "personal"
      return baseAuthClient.apiKey.create({
        ...opts,
        configId: orgScoped ? "org-keys" : "default",
        permissions: opts.permissions ?? defaultApiKeyPermissions,
      })
    },
  },
}) as typeof baseAuthClient

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
  useListOrganizations,
} = authClient
