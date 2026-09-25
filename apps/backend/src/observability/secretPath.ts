/**
 * Better Auth and app routes that put a credential in the path.
 * Query tokens are already omitted (`c.req.path`, client `url.full`).
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

export function redactSecretPath(value: string): string {
  let next = value
  for (const rule of SECRET_PATH_RULES) {
    next = next.replace(rule.pattern, rule.replacement)
  }
  return next
}

/** Redact secret path segments in every string of a wide event, including nested logs. */
export function redactSecretPathsInTree(value: unknown): void {
  const seen = new Set<object>()
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const child = node[index]
        if (typeof child === "string") node[index] = redactSecretPath(child)
        else visit(child)
      }
      return
    }
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const child = record[key]
      if (typeof child === "string") record[key] = redactSecretPath(child)
      else visit(child)
    }
  }
  visit(value)
}
