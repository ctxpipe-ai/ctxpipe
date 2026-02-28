import { oauthProviderClient } from "@better-auth/oauth-provider/client"
// import { passkeyClient } from "@better-auth/passkey/client"
import { organizationClient, twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  basePath: "/.auth/api/v1/auth",
  plugins: [
    organizationClient(),
    twoFactorClient(),
    // passkeyClient(),
    oauthProviderClient(),
  ],
})

export const { signIn, signOut, signUp, useSession, getSession } = authClient
