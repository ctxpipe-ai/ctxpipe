import type { z } from "zod"

type Scope = Record<string, unknown>

/**
 * Split a legacy scope that has a list above its cap (CTX-822) into scopes
 * that each keep in the caps of `schema`. The upgrade (ADR-053) uses it, so
 * that a long list from the old connection settings becomes several source
 * entries and not an invalid one.
 *
 * - A list at the top (for example Slack `channels`) goes into parts of at
 *   most the cap.
 * - A list in one item of a top list (Confluence `spaces[i].pages`) goes
 *   into parts too. Each part after the first gets that item alone.
 *
 * The first scope keeps all the other keys. Each other scope keeps only the
 * keys that are not lists, so that no list item is in two scopes. A scope
 * with no list above a cap comes back as it is.
 */
export function splitLegacyScope(schema: z.ZodType, scope: Scope): Scope[] {
  const parsed = schema.safeParse(scope)
  const issue = parsed.success
    ? undefined
    : parsed.error.issues.find(
        (item) => item.code === "too_big" && item.origin === "array",
      )
  if (!issue || issue.code !== "too_big") return [scope]
  const max = Number(issue.maximum)
  const [key, index, inner] = issue.path
  if (typeof key !== "string" || !Array.isArray(scope[key])) return [scope]
  const list = scope[key] as unknown[]
  const parts = (items: unknown[]) =>
    Array.from({ length: Math.ceil(items.length / max) }, (_, n) =>
      items.slice(n * max, (n + 1) * max),
    )
  const scalars = Object.fromEntries(
    Object.entries(scope).filter(([, value]) => !Array.isArray(value)),
  )
  let scopes: Scope[]
  if (typeof index === "number" && typeof inner === "string") {
    const item = list[index] as Scope
    const [first = [], ...rest] = parts(item[inner] as unknown[])
    scopes = [
      {
        ...scope,
        [key]: list.map((other, i) =>
          i === index ? { ...item, [inner]: first } : other,
        ),
      },
      ...rest.map((part) => ({
        ...scalars,
        [key]: [{ ...item, [inner]: part }],
      })),
    ]
  } else {
    const [first = [], ...rest] = parts(list)
    scopes = [
      { ...scope, [key]: first },
      ...rest.map((part) => ({ ...scalars, [key]: part })),
    ]
  }
  // A shape that cannot be split ends here.
  if (scopes.length === 1) return scopes
  // The first scope can still have another long list.
  return scopes.flatMap((part) => splitLegacyScope(schema, part))
}

/**
 * Parse a legacy scope like `schema.safeParse`, but accept a list above its
 * cap when each part of {@link splitLegacyScope} is valid. The upgrade then
 * splits the scope into several entries. The scope schemas have no
 * transforms, so the data is the scope itself.
 */
export function parseLegacyScope<T>(
  schema: z.ZodType<T>,
  scope: Scope,
): z.ZodSafeParseResult<T> {
  const parts = splitLegacyScope(schema, scope)
  if (parts.length === 1) return schema.safeParse(scope)
  for (const part of parts) {
    const parsed = schema.safeParse(part)
    if (!parsed.success) return parsed
  }
  return { success: true, data: scope as T }
}
