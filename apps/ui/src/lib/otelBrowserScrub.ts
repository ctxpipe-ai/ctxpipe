/**
 * Browser OTLP must not leave this server with a query string, fragment,
 * reset-password or invitation path segment, or email. The JSON reviver
 * visits every string, so span names, attribute values, and log bodies
 * share one pass.
 */
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const EMBEDDED_URL = /https?:\/\/[^\s<>"']+|\/[^\s<>"']+/g

function redactSecretPath(value: string): string {
  return value
    .replace(/\/reset-password\/[^/?#]+/g, "/reset-password/{token}")
    .replace(
      /\/public\/invitations\/[^/?#]+/g,
      "/public/invitations/{invitation}",
    )
}

/** Drop query, fragment, and userinfo, then redact credential path segments. */
function scrubTelemetryUrl(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value)
      url.search = ""
      url.hash = ""
      url.username = ""
      url.password = ""
      const path = redactSecretPath(url.pathname || "/")
      return `${url.origin}${path}`
    } catch {
      // Fall through to the path trimmer.
    }
  }
  const cut = value.split(/[?#]/, 1)[0] ?? value
  return redactSecretPath(cut)
}

function scrubTelemetryString(value: string): string {
  return value
    .replace(EMBEDDED_URL, (part) => scrubTelemetryUrl(part))
    .replace(EMAIL, "{email}")
}

type JsonRecord = Record<string, unknown>

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
  environment: string,
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
        stringAttribute("deployment.environment", environment),
      ]
      const sessionId = browserSessionId(resourceSpans as JsonRecord)
      if (sessionId) {
        attributes.push(stringAttribute("rum.sessionId", sessionId))
      }
      ;(resourceSpans as JsonRecord).resource = { attributes }
    }
  }
}

/**
 * The HyperDX console capture has no level option. Keep `console.warn` (errors
 * come from the error instrumentation) and drop log, info, and debug lines,
 * which are mostly third-party noise.
 */
export function dropVerboseConsoleSpans(payload: unknown): void {
  const resources = (payload as JsonRecord | null)?.resourceSpans
  if (!Array.isArray(resources)) return
  for (const resource of resources) {
    const scopes = (resource as JsonRecord | null)?.scopeSpans
    if (!Array.isArray(scopes)) continue
    for (const scope of scopes) {
      const record = scope as JsonRecord | null
      if (!record || !Array.isArray(record.spans)) continue
      record.spans = record.spans.filter((span) => !isVerboseConsoleSpan(span))
    }
  }
}

function isVerboseConsoleSpan(span: unknown): boolean {
  const attributes = (span as JsonRecord | null)?.attributes
  if (!Array.isArray(attributes)) return false
  const value = (key: string) =>
    (
      attributes.find((a) => (a as JsonRecord | null)?.key === key) as
        | JsonRecord
        | undefined
    )?.value as JsonRecord | undefined
  if (value("component")?.stringValue !== "console") return false
  const level = value("level")?.stringValue
  return level === "info" || level === "debug"
}

/** Parse OTLP/JSON and scrub every string. Throws SyntaxError on malformed JSON. */
export function scrubOtlpJsonText(text: string): unknown {
  const emptyIdentityKeys = new Set([
    "userId",
    "teamId",
    "teamName",
    "enduser.id",
    "ctxpipe.org.id",
    "ctxpipe.org.slug",
  ])
  return JSON.parse(text, (key, value: unknown) => {
    if (typeof value === "string") return scrubTelemetryString(value)
    if (key !== "attributes" || !Array.isArray(value)) return value
    return value.filter((attribute) => {
      if (!attribute || typeof attribute !== "object") return true
      const record = attribute as JsonRecord
      if (
        typeof record.key !== "string" ||
        !emptyIdentityKeys.has(record.key)
      ) {
        return true
      }
      const nested = record.value
      if (!nested || typeof nested !== "object") return true
      return (nested as JsonRecord).stringValue !== ""
    })
  })
}
