import { parseEnv } from "../config/env.js"
import { initDb } from "../db/client.js"
import { createBetterAuth } from "./config.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initDb(env.DATABASE_URL)
export const auth = createBetterAuth()
export default auth
