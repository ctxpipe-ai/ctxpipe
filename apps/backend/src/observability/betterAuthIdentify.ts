import {
  createAuthMiddleware,
  type BetterAuthInstance,
} from "evlog/better-auth"
import { getAuth } from "../auth/config.js"
import { parseEnv } from "../config/env.js"

const env = parseEnv(process.env as Record<string, string | undefined>)

const authForEvlog = getAuth() as unknown as BetterAuthInstance

/**
 * Resolves Better Auth session from cookies and attaches safe user/session fields
 * to the request-wide evlog logger (see https://www.evlog.dev/logging/better-auth).
 */
export const identifyBetterAuthUser = createAuthMiddleware(authForEvlog, {
  exclude: [
    "/.auth/api/v1/auth/**",
    "/.auth/api/config",
    "/.auth/api/v1/public/**",
    "/.well-known/**",
    "/.status",
    "/api/v1/webhook/**",
  ],
  maskEmail: env.NODE_ENV === "production",
})
