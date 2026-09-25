/**
 * Browser OTLP must not leave this server with a query string, fragment,
 * credential path segment, or email. Mirrors the backend secret-path rules
 * without importing them.
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

const LLM_ATTRIBUTE_KEY = /^(gen_ai|langfuse|llm)\./
const LLM_SCOPE_NAME = /langfuse|langchain|langgraph/i
const EMBEDDED_URL = /https?:\/\/[^\s<>"']+|\/[^\s<>"']+/g
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const MAX_SCRUB_DEPTH = 32

export class OtelScrubDepthError extends Error {
  constructor() {
    super("OTLP JSON exceeded nesting limit")
    this.name = "OtelScrubDepthError"
  }
}

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

/** Scrub every URL and email inside a string, including span names and messages. */
export function scrubTelemetryString(value: string): string {
  const withoutEmails = value.replace(EMAIL, "{email}")
  return withoutEmails.replace(EMBEDDED_URL, (part) =>
    looksLikeTelemetryUrl(part) ? scrubTelemetryUrl(part) : part,
  )
}

export function scrubTelemetrySpanName(name: string): string {
  return scrubTelemetryString(name)
}

type JsonRecord = Record<string, unknown>

function scrubOtlpValue(value: unknown, depth: number): void {
  if (depth > MAX_SCRUB_DEPTH) throw new OtelScrubDepthError()
  if (!value || typeof value !== "object") return
  const record = value as JsonRecord
  if (typeof record.stringValue === "string") {
    record.stringValue = scrubTelemetryString(record.stringValue)
  }
  const array = record.arrayValue
  if (array && typeof array === "object") {
    const values = (array as JsonRecord).values
    if (Array.isArray(values)) {
      for (const item of values) scrubOtlpValue(item, depth + 1)
    }
  }
  const kv = record.kvlistValue
  if (kv && typeof kv === "object") {
    const values = (kv as JsonRecord).values
    if (Array.isArray(values)) {
      for (const item of values) {
        if (item && typeof item === "object") {
          scrubOtlpValue((item as JsonRecord).value, depth + 1)
        }
      }
    }
  }
}

function stripLlmAttributes(attributes: unknown): void {
  if (!Array.isArray(attributes)) return
  let index = 0
  while (index < attributes.length) {
    const attribute = attributes[index]
    const key =
      attribute && typeof attribute === "object"
        ? (attribute as JsonRecord).key
        : undefined
    if (typeof key === "string" && LLM_ATTRIBUTE_KEY.test(key)) {
      attributes.splice(index, 1)
      continue
    }
    index += 1
  }
}

function neutralizeLlmScope(entry: JsonRecord): void {
  for (const key of ["scope", "instrumentationLibrary"] as const) {
    const scope = entry[key]
    if (!scope || typeof scope !== "object") continue
    const name = (scope as JsonRecord).name
    if (typeof name === "string" && LLM_SCOPE_NAME.test(name)) {
      ;(scope as JsonRecord).name = "ui"
    }
  }
}

function scrubAttributes(attributes: unknown, depth: number): void {
  if (!Array.isArray(attributes)) return
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") continue
    scrubOtlpValue((attribute as JsonRecord).value, depth + 1)
  }
}

function scrubScopeSpans(scopes: unknown, depth: number): void {
  if (!Array.isArray(scopes)) return
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue
    const entry = scope as JsonRecord
    neutralizeLlmScope(entry)
    const spans = entry.spans
    if (!Array.isArray(spans)) continue
    for (const span of spans) {
      if (!span || typeof span !== "object") continue
      const record = span as JsonRecord
      if (typeof record.name === "string") {
        record.name = scrubTelemetryString(record.name)
      }
      stripLlmAttributes(record.attributes)
      scrubAttributes(record.attributes, depth)
      const events = record.events
      if (!Array.isArray(events)) continue
      for (const event of events) {
        if (!event || typeof event !== "object") continue
        const eventRecord = event as JsonRecord
        if (typeof eventRecord.name === "string") {
          eventRecord.name = scrubTelemetryString(eventRecord.name)
        }
        stripLlmAttributes(eventRecord.attributes)
        scrubAttributes(eventRecord.attributes, depth)
      }
    }
  }
}

function scrubScopeLogs(scopes: unknown, depth: number): void {
  if (!Array.isArray(scopes)) return
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue
    const entry = scope as JsonRecord
    neutralizeLlmScope(entry)
    const records = entry.logRecords
    if (!Array.isArray(records)) continue
    for (const logRecord of records) {
      if (!logRecord || typeof logRecord !== "object") continue
      const record = logRecord as JsonRecord
      if (typeof record.body === "string") {
        record.body = scrubTelemetryString(record.body)
      } else {
        scrubOtlpValue(record.body, depth + 1)
      }
      stripLlmAttributes(record.attributes)
      scrubAttributes(record.attributes, depth)
    }
  }
}

function stringAttribute(key: string, value: string): JsonRecord {
  return { key, value: { stringValue: value } }
}

/** HyperDX links trace and log rows to a browser session by this resource attribute. */
function browserSessionId(resourceSpans: JsonRecord): string | null {
  const resource = resourceSpans.resource as JsonRecord | undefined
  if (!resource || !Array.isArray(resource.attributes)) return null
  for (const attribute of resource.attributes) {
    const record = attribute as JsonRecord | null
    if (record?.key !== "rum.sessionId") continue
    const value = (record.value as JsonRecord | undefined)?.stringValue
    return typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
      ? value
      : null
  }
  return null
}

/** Replace caller resource attributes with the UI service identity and session id. */
export function restrictBrowserResourceAttributes(
  payload: unknown,
  environment: string | undefined,
): void {
  if (!payload || typeof payload !== "object") return
  const record = payload as JsonRecord
  for (const key of ["resourceSpans", "resourceLogs"] as const) {
    const resources = record[key]
    if (!Array.isArray(resources)) continue
    for (const resourceSpans of resources) {
      if (!resourceSpans || typeof resourceSpans !== "object") continue
      const attributes = [
        stringAttribute("service.name", "ui"),
        stringAttribute("service.namespace", "ctxpipe"),
      ]
      if (environment) {
        attributes.push(stringAttribute("deployment.environment", environment))
      }
      const sessionId = browserSessionId(resourceSpans as JsonRecord)
      if (sessionId) {
        attributes.push(stringAttribute("rum.sessionId", sessionId))
      }
      ;(resourceSpans as JsonRecord).resource = { attributes }
    }
  }
}

/** Mutates an OTLP/JSON document. Throws {@link OtelScrubDepthError} past the depth limit. */
export function scrubBrowserOtlpJson(payload: unknown): void {
  if (!payload || typeof payload !== "object") return
  const record = payload as JsonRecord
  const resources = record.resourceSpans
  if (Array.isArray(resources)) {
    for (const resourceSpans of resources) {
      if (!resourceSpans || typeof resourceSpans !== "object") continue
      const entry = resourceSpans as JsonRecord
      const resource = entry.resource
      if (resource && typeof resource === "object") {
        scrubAttributes((resource as JsonRecord).attributes, 0)
      }
      scrubScopeSpans(entry.scopeSpans, 0)
    }
  }
  const logs = record.resourceLogs
  if (Array.isArray(logs)) {
    for (const resourceLogs of logs) {
      if (!resourceLogs || typeof resourceLogs !== "object") continue
      const entry = resourceLogs as JsonRecord
      const resource = entry.resource
      if (resource && typeof resource === "object") {
        scrubAttributes((resource as JsonRecord).attributes, 0)
      }
      scrubScopeLogs(entry.scopeLogs, 0)
    }
  }
}
