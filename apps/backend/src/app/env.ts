import type { AuthSession, AuthUser } from "../auth/config.js"
import type { Env } from "../config/env.js"

export type AppEnv = {
  Variables: {
    env: Env
    user: AuthUser | null
    session: AuthSession | null
    orgSlug: string | null
    orgId: string | null
  }
}
