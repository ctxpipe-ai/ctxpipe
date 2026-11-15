/**
 * The smoke checks of a deployed ctxpipe (CTX-1217): the status, the UI, the
 * OAuth metadata of the origin, the MCP challenge, the OpenAPI spec and an
 * MCP read with an API key of a test organization. The checks change no
 * customer row. The only database write is the request counter of the test
 * API key (Better Auth). It prints the results as JSON and exits with 1 when
 * a check fails.
 *
 *   bun run src/scripts/validateTarget.ts https://<host> [--no-mcp-read]
 *
 * The origin must be the AUTH_BASE_URL of the stack. Before the cutover
 * window, that is https://cutover.ctxpipe.dev. In the window, it is
 * https://app.ctxpipe.ai. The script refuses http:// on a host that is not
 * loopback.
 *
 * Environment: VALIDATE_API_KEY (a personal API key of a test organization).
 * Without it, the `mcp read` check fails. Give --no-mcp-read to skip that
 * check, for example on an empty database. Optional: CF_ACCESS_CLIENT_ID and
 * CF_ACCESS_CLIENT_SECRET (the Cloudflare Access service token of an
 * internal host name).
 *
 * Inside the target, as its one-off task with the backend's environment:
 *
 *   bun run src/scripts/validateTarget.ts --secrets
 *
 * It decrypts each stored connection secret with the target's key, and mints
 * (then revokes) a GitHub installation token with the target's App ID and
 * key. The HTTP checks pass with a wrong value of either secret.
 */
import { parseEnv } from "../config/env.js"
import { closeDb, initDb } from "../db/client.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { validateTargetSecrets } from "../lib/validate-target-secrets.js"
import { type CheckResult, validateTarget } from "../lib/validate-target.js"
import { initEvlog } from "../observability/logger.js"

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--secrets")) {
    // No log: a transaction log of the org context names the organization.
    initEvlog({ silent: true })
    const env = parseEnv(process.env)
    initDb(env.DATABASE_URL)
    try {
      return report(await validateTargetSecrets(env))
    } finally {
      await closeDb()
    }
  }
  const baseUrl = argv.find((arg) => !arg.startsWith("--"))
  if (!baseUrl)
    throw new Error(
      "Give the backend origin, for example https://app.ctxpipe.ai",
    )
  const id = process.env.CF_ACCESS_CLIENT_ID
  const secret = process.env.CF_ACCESS_CLIENT_SECRET
  const results = await validateTarget({
    baseUrl,
    ...(id && secret
      ? {
          headers: {
            "CF-Access-Client-Id": id,
            "CF-Access-Client-Secret": secret,
          },
        }
      : {}),
    ...(process.env.VALIDATE_API_KEY
      ? { apiKey: process.env.VALIDATE_API_KEY }
      : {}),
    skipMcpRead: argv.includes("--no-mcp-read"),
  })
  return report(results)
}

function report(results: CheckResult[]): number {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  return results.every((result) => result.ok) ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${formatUnknownError(error)}\n`)
    process.exit(1)
  },
)
