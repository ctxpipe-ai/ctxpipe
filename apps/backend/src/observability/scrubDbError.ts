const DROPPED_PG_FIELDS = new Set([
  "detail",
  "where",
  "internalQuery",
  "hint",
])

function isRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value)
}

function isSqlState(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)
}

/** Drizzle's `Failed query:` error puts bound values on a `params:` line. */
export function scrubDrizzleParams(text: string): string {
  if (!/Failed query:/i.test(text)) return text
  return text.replace(/\r?\nparams:[^\r\n]*/gi, "")
}

function isPgErrorShape(record: object): boolean {
  const fields = record as Record<string, unknown>
  if (isSqlState(fields.code)) return true
  if (typeof fields.severity === "string") return true
  if (typeof fields.constraint === "string") return true
  if (typeof fields.routine === "string") return true
  if (typeof fields.schema === "string" && typeof fields.table === "string") {
    return true
  }
  return (
    typeof fields.message === "string" && /Failed query:/i.test(fields.message)
  )
}

function isSkippedContainer(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof Map || value instanceof Set
}

/**
 * Copy of a log value with Drizzle `params:` tails removed and pg
 * `detail` / `where` / `internalQuery` / `hint` dropped. The input is not mutated.
 */
export function scrubDbErrorTree(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>()

  const visit = (node: unknown): unknown => {
    try {
      if (typeof node === "string") {
        const next = scrubDrizzleParams(node)
        return next === node ? node : next
      }
      if (!node || typeof node !== "object") return node
      const cached = seen.get(node)
      if (cached !== undefined) return cached
      if (isSkippedContainer(node)) return node
      if (Array.isArray(node)) return visitArray(node, seen, visit)
      if (node instanceof Error) return visitError(node, seen, visit)
      if (!isRecord(node)) return node
      return visitRecord(node, seen, visit)
    } catch {
      return node
    }
  }

  return visit(value)
}

function visitArray(
  values: unknown[],
  seen: WeakMap<object, unknown>,
  visit: (node: unknown) => unknown,
): unknown {
  const copy: unknown[] = []
  seen.set(values, copy)
  let changed = false
  for (const child of values) {
    const next = visit(child)
    copy.push(next)
    if (next !== child) changed = true
  }
  if (!changed) {
    seen.set(values, values)
    return values
  }
  return copy
}

function visitRecord(
  record: Record<string, unknown>,
  seen: WeakMap<object, unknown>,
  visit: (node: unknown) => unknown,
): unknown {
  const copy: Record<string, unknown> = {}
  seen.set(record, copy)
  const dropSecrets = isPgErrorShape(record)
  let changed = false
  for (const key of Object.keys(record)) {
    if (dropSecrets && DROPPED_PG_FIELDS.has(key)) {
      changed = true
      continue
    }
    const child = record[key]
    const next = visit(child)
    copy[key] = next
    if (next !== child) changed = true
  }
  if (!changed) {
    seen.set(record, record)
    return record
  }
  return copy
}

function visitError(
  error: Error,
  seen: WeakMap<object, unknown>,
  visit: (node: unknown) => unknown,
): unknown {
  const copy: Record<string, unknown> = {}
  seen.set(error, copy)
  const message = scrubDrizzleParams(error.message)
  copy.name = error.name
  copy.message = message
  let changed = message !== error.message
  if (typeof error.stack === "string") {
    const stack = scrubDrizzleParams(error.stack)
    copy.stack = stack
    if (stack !== error.stack) changed = true
  }
  const dropSecrets = isPgErrorShape(error)
  const record = error as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key === "name" || key === "message" || key === "stack") continue
    if (dropSecrets && DROPPED_PG_FIELDS.has(key)) {
      changed = true
      continue
    }
    const child = record[key]
    const next = visit(child)
    copy[key] = next
    if (next !== child) changed = true
  }
  if (error.cause !== undefined && !Object.hasOwn(copy, "cause")) {
    const next = visit(error.cause)
    copy.cause = next
    if (next !== error.cause) changed = true
  }
  if (!changed) {
    seen.set(error, error)
    return error
  }
  return copy
}

/** Install scrubbed copies on the event evlog will emit. Nested inputs stay intact. */
export function applyScrubDbErrors(event: Record<string, unknown>): void {
  let scrubbed: unknown
  try {
    scrubbed = scrubDbErrorTree(event)
  } catch {
    return
  }
  if (!scrubbed || typeof scrubbed !== "object" || Array.isArray(scrubbed)) {
    return
  }
  const copy = scrubbed as Record<string, unknown>
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

/** Exception for a failed query span. No bound values, detail, or cause chain. */
export function dbErrorException(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const message = scrubDrizzleParams(raw).replace(/\s+/g, " ").trim().slice(0, 300)
  const sanitized = new Error(message || "database query failed")
  sanitized.name = error instanceof Error && error.name ? error.name : "error"
  if (error instanceof Error && typeof error.stack === "string") {
    const stack = scrubDrizzleParams(error.stack)
    if (!/params:/i.test(stack)) sanitized.stack = stack
  }
  return sanitized
}
