import { passkeyClient } from "@better-auth/passkey/client"
import { organizationClient, twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  basePath: "/.auth",
  plugins: [organizationClient(), twoFactorClient(), passkeyClient()],
})

export const { signIn, signOut, signUp, useSession, getSession, useListOrganizations } = authClient
