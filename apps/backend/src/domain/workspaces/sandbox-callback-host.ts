import { isIP } from "node:net"

/**
 * The checked value of `SANDBOX_CALLBACK_HOST`: a bare host name or IP
 * address, with no scheme, port, path, or credentials. The chat callback and
 * the ingest callback origin use the same rule.
 */
export function parseSandboxCallbackHost(raw: string): string {
  const unwrapped =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw
  const ipVersion = isIP(unwrapped)
  if (
    /[/\\?#]/.test(raw) ||
    (raw.includes(":") && ipVersion !== 6) ||
    (raw !== unwrapped && ipVersion !== 6)
  ) {
    throw new Error("SANDBOX_CALLBACK_HOST must be a hostname or IP address")
  }
  const candidate = ipVersion === 6 ? `[${unwrapped}]` : raw
  let parsed: URL
  try {
    parsed = new URL(`http://${candidate}`)
  } catch {
    throw new Error("SANDBOX_CALLBACK_HOST must be a hostname or IP address")
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SANDBOX_CALLBACK_HOST must be a hostname or IP address")
  }
  return parsed.host
}
