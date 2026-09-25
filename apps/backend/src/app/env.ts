import type { EvlogVariables } from "evlog/hono"
import type { AuthSession, AuthUser } from "../auth/config.js"
import type { Env } from "../config/env.js"

/** Org-owned MCP API key. No user session — `orgId` is the key's `referenceId`. */
export type OrgApiKeyPrincipal = {
  id: string
  orgId: string
  configId: string
}

export type AppEnv = EvlogVariables & {
  Variables: {
    env: Env
    user: AuthUser | null
    session: AuthSession | null
    oauthOrganizationId: string | null
    oauthClientId?: string | null
    orgApiKey: OrgApiKeyPrincipal | null
    orgSlug: string | null
    orgId: string | null
  }
}
