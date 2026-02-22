import { createAuthClient } from "better-auth/react"
import { passkeyClient } from "@better-auth/passkey/client"
import { organizationClient, twoFactorClient } from "better-auth/client/plugins"

const baseURL =
  import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "") ?? "http://localhost:3000"

export const authClient = createAuthClient({
  baseURL,
  plugins: [organizationClient(), twoFactorClient(), passkeyClient()],
})

export const { signIn, signOut, signUp, useSession, getSession } = authClient
