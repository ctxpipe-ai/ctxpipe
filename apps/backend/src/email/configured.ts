import type { Env } from "../config/env.js"

/**
 * The email transport of the process, or undefined when it cannot send
 * email. Kept apart from `index.ts`, so that a caller does not load the
 * senders.
 */
export function emailTransport(
  env: Env,
):
  | { kind: "ses"; from: string }
  | { kind: "smtp"; from: string; connectionUrl: string }
  | undefined {
  const from = env.EMAIL_FROM_ADDRESS
  if (!from) return undefined
  if (env.EMAIL_TRANSPORT === "ses") return { kind: "ses", from }
  if (env.SMTP_CONNECTION_URL)
    return { kind: "smtp", from, connectionUrl: env.SMTP_CONNECTION_URL }
  return undefined
}
