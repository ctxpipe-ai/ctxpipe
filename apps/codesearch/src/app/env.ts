import type { EvlogVariables } from "evlog/hono"
import type { VerifiedToken } from "../auth/jwt.js"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"

export type AppEnv = EvlogVariables & {
  Variables: {
    db: Db | null
    env: Env
    auth: VerifiedToken | null
  }
}
