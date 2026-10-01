/**
 * Postgres jsonb rejects U+0000 and unpaired UTF-16 surrogates. The driver
 * sends those as `\u` escapes, and the server answers
 * "unsupported Unicode escape sequence", which fails the step write.
 */
export function sanitizePostgresJson<T>(value: T): T {
  if (typeof value === "string") {
    return stripUnsafe(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePostgresJson(item)) as T
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = sanitizePostgresJson(item)
    }
    return out as T
  }
  return value
}

function stripUnsafe(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0) continue
    const next = text.charCodeAt(i + 1)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1]
        i += 1
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue
    out += text[i]
  }
  return out
}
