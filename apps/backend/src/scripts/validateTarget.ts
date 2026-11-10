/**
 * The smoke checks of a deployed ctxpipe (CTX-1217): the status, the UI, the OAuth
 * metadata of the origin, the MCP challenge, the OpenAPI spec and, with an
 * API key of a test organization, an MCP read. Each check only reads. It
 * prints the results as JSON and exits with 1 when a check fails.
 *
 *   bun run src/scripts/validateTarget.ts https://<host>
 *
 * Optional environment: VALIDATE_API_KEY (a personal API key of a test
 * organization), CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (the
 * Cloudflare Access service token of an internal host name).
 */
import { validateTarget } from "../lib/validate-target.js"

async function main(argv: string[]): Promise<number> {
  const baseUrl = argv[0]
  if (!baseUrl?.startsWith("https://") && !baseUrl?.startsWith("http://"))
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
  })
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  return results.every((result) => result.ok) ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  },
)
