import { scrubTelemetryString } from "@/lib/otelScrub"

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
 * Parse OTLP/JSON and scrub every string. Throws SyntaxError on malformed JSON.
 *
 * The HyperDX console capture has no level option. It names each span
 * `console.<method>`, and a logged object can overwrite its `level`
 * attribute, so the filter reads the name. `console.warn` stays;
 * `console.error` comes from the error instrumentation, not this capture.
 */
export function scrubOtlpJsonText(text: string): unknown {
  const verboseConsoleSpans = new Set([
    "console.log",
    "console.info",
    "console.debug",
  ])
  const emptyIdentityKeys = new Set([
    "enduser.id",
    "ctxpipe.org.id",
    "ctxpipe.org.slug",
  ])
  return JSON.parse(text, (key, value: unknown) => {
    if (typeof value === "string") return scrubTelemetryString(value)
    if (key === "spans" && Array.isArray(value)) {
      return value.filter(
        (span) =>
          !verboseConsoleSpans.has((span as JsonRecord | null)?.name as string),
      )
    }
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
