/**
 * Better Auth and app routes that put a credential in the path.
 * Query strings are stripped by evlog redact patterns in `logger.ts`.
 * Wide-event walks live there too (`initLogger({ redact })`).
 *
 * Audited (Better Auth plugins in use + backend routes):
 * - `reset-password/:token` — credential (email link).
 * - `/.auth/api/v1/public/invitations/:invitationId` — unauthenticated
 *   capability; the id returns the invitee's email.
 * - verify-email, magic link, device/OAuth/MCP — token is a query param or
 *   body, not a path segment. Magic link is not enabled.
 * - `/callback/:id` is the provider name. OAuth client ids are public.
 * - GitHub webhook `/:connectionId` is an id, not the HMAC secret.
 * - Forge, Slack, Linear, Notion, and PagerDuty webhook URLs have no secret
 *   segment. Invitation acceptance emails use query params. No share-link
 *   route puts a secret in the path.
 */
const SECRET_PATH_RULES: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /\/reset-password\/[^/?#]+/g,
    replacement: "/reset-password/{token}",
  },
  {
    pattern: /\/public\/invitations\/[^/?#]+/g,
    replacement: "/public/invitations/{invitation}",
  },
]

/** Span and client URL helper. Log bodies use evlog patterns instead. */
export function redactSecretPath(value: string): string {
  let next = value
  for (const rule of SECRET_PATH_RULES) {
    rule.pattern.lastIndex = 0
    next = next.replace(rule.pattern, rule.replacement)
  }
  return next
}
