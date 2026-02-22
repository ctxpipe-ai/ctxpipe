import { parseEnv } from "../config/env.js"
import { getAuth } from "./config.js"

const env = parseEnv(process.env as Record<string, string | undefined>)

export const auth = getAuth(env)
export default auth
