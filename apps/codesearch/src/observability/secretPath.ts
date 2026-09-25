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
