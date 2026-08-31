import type { EvlogVariables } from "evlog/hono"
import type { AuthSession, AuthUser } from "../auth/config.js"
import type { Env } from "../config/env.js"

export type AppEnv = EvlogVariables & {
  Variables: {
    env: Env
    user: AuthUser | null
    session: AuthSession | null
    oauthOrganizationId: string | null
    orgSlug: string | null
    orgId: string | null
  }
}
