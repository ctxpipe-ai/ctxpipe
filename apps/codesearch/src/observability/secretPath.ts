/**
 * Same path rules as `apps/backend/src/observability/secretPath.ts`.
 * Codesearch does not import the backend package.
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
