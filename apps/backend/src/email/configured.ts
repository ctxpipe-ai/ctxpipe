import type { Env } from "../config/env.js"

/**
 * True when the process can send email: a sender address and a transport.
 * Kept apart from `index.ts`, so that a caller does not load the senders.
 */
export function emailConfigured(env: Env): boolean {
  if (!env.EMAIL_FROM_ADDRESS) return false
  return env.EMAIL_TRANSPORT === "ses" || Boolean(env.SMTP_CONNECTION_URL)
}
