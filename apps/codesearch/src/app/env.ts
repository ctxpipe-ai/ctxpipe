import type { EvlogVariables } from "evlog/hono"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"

export type AuthClaims = {
  sub: string
  orgId: string
  principal: "user" | "service"
  workspaceId?: string
}

export type AppEnv = EvlogVariables & {
  Variables: {
    db: Db | null
    env: Env
    auth: AuthClaims | null
  }
}
