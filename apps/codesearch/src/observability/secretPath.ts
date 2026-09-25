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
    rule.pattern.lastIndex = 0
    next = next.replace(rule.pattern, rule.replacement)
  }
  return next
}

const REDACTED_FIELD = "[redacted]"

function isTypedArrayOrBuffer(value: object): boolean {
  return ArrayBuffer.isView(value)
}

function isPlainObject(value: object): boolean {
  if (isTypedArrayOrBuffer(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Redacted copy of a wide event. Plain objects and arrays are copied when a
 * string changes. Typed arrays, buffers, maps, sets, and class instances are
 * left unwalked. A field that cannot be read is replaced, not emitted raw.
 * The input is not mutated.
 */
export function redactSecretPathsInTree(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>()

  const visit = (node: unknown): unknown => {
    try {
      if (typeof node === "string") {
        const redacted = redactSecretPath(node)
        return redacted === node ? node : redacted
      }
      if (!node || typeof node !== "object") return node
      const cached = seen.get(node)
      if (cached !== undefined) return cached
      if (
        isTypedArrayOrBuffer(node) ||
        node instanceof Map ||
        node instanceof Set
      ) {
        return node
      }
      if (Array.isArray(node)) {
        const copy: unknown[] = []
        seen.set(node, copy)
        let changed = false
        for (let index = 0; index < node.length; index++) {
          try {
            const child = node[index]
            const next = visit(child)
            copy[index] = next
            if (next !== child) changed = true
          } catch {
            copy[index] = REDACTED_FIELD
            changed = true
          }
        }
        if (!changed) {
          seen.set(node, node)
          return node
        }
        return copy
      }
      if (!isPlainObject(node)) return node
      const record = node as Record<string, unknown>
      const copy: Record<string, unknown> = {}
      seen.set(node, copy)
      let changed = false
      let keys: string[]
      try {
        keys = Object.keys(record)
      } catch {
        return REDACTED_FIELD
      }
      for (const key of keys) {
        try {
          const child = record[key]
          const next = visit(child)
          copy[key] = next
          if (next !== child) changed = true
        } catch {
          copy[key] = REDACTED_FIELD
          changed = true
        }
      }
      if (!changed) {
        seen.set(node, node)
        return node
      }
      return copy
    } catch {
      return REDACTED_FIELD
    }
  }

  return visit(value)
}

/** Install redacted copies on the event evlog will emit. Nested inputs stay intact. */
export function applyRedactedSecretPaths(event: Record<string, unknown>): void {
  let redacted: unknown
  try {
    redacted = redactSecretPathsInTree(event)
  } catch {
    return
  }
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
    return
  }
  const copy = redacted as Record<string, unknown>
  if (copy === event) return
  for (const key of Object.keys(event)) {
    if (!Object.hasOwn(copy, key)) {
      try {
        delete event[key]
      } catch {
        /* non-configurable */
      }
    }
  }
  for (const [key, value] of Object.entries(copy)) {
    if (event[key] === value) continue
    try {
      event[key] = value
    } catch {
      try {
        delete event[key]
      } catch {
        /* frozen event field cannot be dropped */
      }
    }
  }
}
