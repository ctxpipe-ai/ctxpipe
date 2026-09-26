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

/** Parse OTLP/JSON and scrub every string. Throws SyntaxError on malformed JSON. */
export function scrubOtlpJsonText(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === "string" ? scrubTelemetryString(value) : value,
  )
}
