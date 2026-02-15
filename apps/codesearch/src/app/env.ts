import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"

export type AppEnv = {
  Variables: {
    db: Db | null
    env: Env
  }
}
