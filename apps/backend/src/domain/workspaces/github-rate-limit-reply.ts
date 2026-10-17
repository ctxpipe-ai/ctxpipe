export type CurlResult = { exitCode: number; stdout: string; stderr: string }

/** The command to run in a sandbox: the body, then the HTTP status on its own line. */
export const GITHUB_RATE_LIMIT_COMMAND =
  "curl -sS -m 20 -w '\\n%{http_code}' https://api.github.com/rate_limit"

/**
 * Read the core request limit from a GitHub rate-limit reply that a sandbox
 * fetched with GITHUB_RATE_LIMIT_COMMAND. Throws a message that names the
 * fault: the firewall (host not resolved), or an outside fault (GitHub
 * down, rate limited, or the connection dropped).
 */
export function parseGithubCoreLimit(result: CurlResult): number {
  if (result.exitCode === 6) {
    throw new Error(
      `Firewall fault: the sandbox could not resolve api.github.com (curl exit 6): ${result.stderr.trim()}`,
    )
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Outside fault: curl could not read a reply from GitHub (exit ${result.exitCode}): ${result.stderr.trim() || "no error text"}`,
    )
  }
  const cut = result.stdout.lastIndexOf("\n")
  const body = cut === -1 ? "" : result.stdout.slice(0, cut)
  const status = Number(result.stdout.slice(cut + 1).trim())
  if (status === 403 || status === 429) {
    throw new Error(
      `Outside fault: GitHub rate limited the request (HTTP ${status}): ${body.slice(0, 200)}`,
    )
  }
  if (status >= 500) {
    throw new Error(`Outside fault: GitHub answered HTTP ${status}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `Firewall fault: HTTP ${status} reply from GitHub was not JSON: ${JSON.stringify(body.slice(0, 200))}`,
    )
  }
  const limit = (parsed as { resources?: { core?: { limit?: unknown } } })
    .resources?.core?.limit
  if (typeof limit !== "number") {
    throw new Error(
      `Firewall fault: HTTP ${status} reply had no core limit: ${body.slice(0, 200)}`,
    )
  }
  return limit
}

/** Outside faults are worth another try; a firewall fault is a real failure. */
export function isOutsideFault(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Outside fault")
}
