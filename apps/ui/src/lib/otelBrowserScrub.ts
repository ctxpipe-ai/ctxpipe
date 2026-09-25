/**
 * Browser OTLP must not leave this server with a query string, fragment, or
 * credential path segment. Mirrors the backend secret-path rules without
 * importing them.
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

export function redactBrowserSecretPath(value: string): string {
  let next = value
  for (const rule of SECRET_PATH_RULES) {
    next = next.replace(rule.pattern, rule.replacement)
  }
  return next
}

export function looksLikeTelemetryUrl(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  )
}

/** Drop query, fragment, and userinfo, then redact credential path segments. */
export function scrubTelemetryUrl(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value)
      url.search = ""
      url.hash = ""
      url.username = ""
      url.password = ""
      const path = redactBrowserSecretPath(url.pathname || "/")
      return `${url.origin}${path}`
    } catch {
      // Fall through to the path trimmer.
    }
  }
  const cut = value.split(/[?#]/, 1)[0] ?? value
  return redactBrowserSecretPath(cut)
}

export function scrubTelemetrySpanName(name: string): string {
  if (!name.includes("?") && !name.includes("#") && !name.includes("reset-password/") && !name.includes("/public/invitations/")) {
    return name
  }
  return name.replace(/https?:\/\/\S+|\/\S+/g, (part) =>
    looksLikeTelemetryUrl(part) ? scrubTelemetryUrl(part) : part,
  )
}

type JsonRecord = Record<string, unknown>

function scrubOtlpValue(value: unknown): void {
  if (!value || typeof value !== "object") return
  const record = value as JsonRecord
  if (typeof record.stringValue === "string" && looksLikeTelemetryUrl(record.stringValue)) {
    record.stringValue = scrubTelemetryUrl(record.stringValue)
  }
  const array = record.arrayValue
  if (array && typeof array === "object") {
    const values = (array as JsonRecord).values
    if (Array.isArray(values)) {
      for (const item of values) scrubOtlpValue(item)
    }
  }
  const kv = record.kvlistValue
  if (kv && typeof kv === "object") {
    const values = (kv as JsonRecord).values
    if (Array.isArray(values)) {
      for (const item of values) {
        if (item && typeof item === "object") {
          scrubOtlpValue((item as JsonRecord).value)
        }
      }
    }
  }
}

function scrubAttributes(attributes: unknown): void {
  if (!Array.isArray(attributes)) return
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") continue
    scrubOtlpValue((attribute as JsonRecord).value)
  }
}

function scrubScopeSpans(scopes: unknown): void {
  if (!Array.isArray(scopes)) return
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue
    const spans = (scope as JsonRecord).spans
    if (!Array.isArray(spans)) continue
    for (const span of spans) {
      if (!span || typeof span !== "object") continue
      const record = span as JsonRecord
      if (typeof record.name === "string") {
        record.name = scrubTelemetrySpanName(record.name)
      }
      scrubAttributes(record.attributes)
      const events = record.events
      if (!Array.isArray(events)) continue
      for (const event of events) {
        if (!event || typeof event !== "object") continue
        const eventRecord = event as JsonRecord
        if (typeof eventRecord.name === "string") {
          eventRecord.name = scrubTelemetrySpanName(eventRecord.name)
        }
        scrubAttributes(eventRecord.attributes)
      }
    }
  }
}

function scrubScopeLogs(scopes: unknown): void {
  if (!Array.isArray(scopes)) return
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue
    const records =
      (scope as JsonRecord).logRecords ?? (scope as JsonRecord).log_records
    if (!Array.isArray(records)) continue
    for (const logRecord of records) {
      if (!logRecord || typeof logRecord !== "object") continue
      const record = logRecord as JsonRecord
      scrubOtlpValue(record.body)
      scrubAttributes(record.attributes)
    }
  }
}

function scrubResources(
  resources: unknown,
  scopeKey: "scopeSpans" | "scopeLogs",
  altScopeKey: string,
  scrubScopes: (scopes: unknown) => void,
): void {
  if (!Array.isArray(resources)) return
  for (const resourceSpans of resources) {
    if (!resourceSpans || typeof resourceSpans !== "object") continue
    const record = resourceSpans as JsonRecord
    const resource = record.resource
    if (resource && typeof resource === "object") {
      scrubAttributes((resource as JsonRecord).attributes)
    }
    scrubScopes(record[scopeKey] ?? record[altScopeKey])
  }
}

/** Mutates an OTLP JSON document. Non-URL strings are left as they are. */
export function scrubBrowserOtlpJson(payload: unknown): void {
  if (!payload || typeof payload !== "object") return
  const record = payload as JsonRecord
  scrubResources(
    record.resourceSpans ?? record.resource_spans,
    "scopeSpans",
    "scope_spans",
    scrubScopeSpans,
  )
  scrubResources(
    record.resourceLogs ?? record.resource_logs,
    "scopeLogs",
    "scope_logs",
    scrubScopeLogs,
  )
}
