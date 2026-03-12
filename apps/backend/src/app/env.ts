import type { AuthSession, AuthUser } from "../auth/config.js"
import type { Env } from "../config/env.js"
import type { EvlogVariables } from "evlog/hono"

export type AppEnv = EvlogVariables & {
  Variables: {
    env: Env
    user: AuthUser | null
    session: AuthSession | null
    orgSlug: string | null
    orgId: string | null
  }
}
