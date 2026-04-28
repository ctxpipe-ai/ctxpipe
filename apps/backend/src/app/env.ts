import type { EvlogVariables } from "evlog/hono"
import type { VerifiedApiKeyRecord } from "../auth/apiKeyVerify.js"
import type { AuthSession, AuthUser } from "../auth/config.js"
import type { Env } from "../config/env.js"

export type ApiKeyAuthContext = {
  rawKey: string
  record: VerifiedApiKeyRecord
}

export type AppEnv = EvlogVariables & {
  Variables: {
    env: Env
    user: AuthUser | null
    session: AuthSession | null
    orgSlug: string | null
    orgId: string | null
    /** Set when the request authenticated via API key (for scope enforcement). */
    apiKeyAuth: ApiKeyAuthContext | null
  }
}
