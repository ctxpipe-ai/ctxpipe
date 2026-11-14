import { isIP } from "node:net"
import { networkInterfaces } from "node:os"

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

/** The VPC DNS name of an IPv4 address: `ip-<a>-<b>-<c>-<d>.<suffix>`. */
export function callbackDnsName(address: string, suffix: string): string {
  return `ip-${address.replaceAll(".", "-")}.${suffix}`
}

/**
 * A test of whether a host name is this backend's own callback name: the
 * host of its model proxy and tool bridge rules. It is the value of
 * `SANDBOX_CALLBACK_HOST`, or else the {@link callbackDnsName} of an IPv4
 * address of a local network interface under `SANDBOX_CALLBACK_DNS_SUFFIX`
 * (the name that `sandboxCallbackHost` derives on AWS). A name for an
 * address of another machine is not this backend's name.
 */
export function isOwnCallbackHost(
  env: Record<string, string | undefined>,
): (hostname: string) => boolean {
  const explicit = env.SANDBOX_CALLBACK_HOST?.trim()
  if (explicit) {
    const host = parseSandboxCallbackHost(explicit).toLowerCase()
    return (hostname) => hostname.toLowerCase() === host
  }
  const suffix = env.SANDBOX_CALLBACK_DNS_SUFFIX?.trim().toLowerCase()
  if (!suffix) return () => false
  return (hostname) =>
    Object.values(networkInterfaces()).some((entries) =>
      entries?.some(
        (entry) =>
          entry.family === "IPv4" &&
          callbackDnsName(entry.address, suffix) === hostname.toLowerCase(),
      ),
    )
}
