/**
 * Encrypts the stored secrets again with the current keys, after an operator
 * changes AUTH_SECRET or CONNECTION_SECRETS_ENCRYPTION_KEY (see the
 * self-hosting "Secrets" page).
 *
 *   bun run src/scripts/reencryptSecrets.ts [--dry-run] [--org <orgId>]
 *
 * With --org, it does only that organization and its members.
 * It reads the old keys from CONNECTION_SECRETS_PREVIOUS_KEYS. It prints
 * counts and the ids of the rows that it cannot decrypt, never a value. Run
 * it again until `failed` is empty; each run skips the current values.
 */
import { parseEnv } from "../config/env.js"
import { closeDb, initDb } from "../db/client.js"
import { reencryptStoredSecrets } from "../lib/reencrypt-stored-secrets.js"
import { initEvlog } from "../observability/logger.js"

initEvlog()
const args = process.argv.slice(2)
const orgFlag = args.indexOf("--org")
if (orgFlag !== -1 && !args[orgFlag + 1]) {
  process.stderr.write("Usage: [--dry-run] [--org <orgId>]\n")
  process.exit(2)
}
const env = parseEnv(process.env)
initDb(env.DATABASE_URL)
try {
  const report = await reencryptStoredSecrets({
    env,
    dryRun: args.includes("--dry-run"),
    orgId: orgFlag === -1 ? undefined : args[orgFlag + 1],
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  const failed =
    report.connections.failed.length +
    report.sandboxGitTokens.failed.length +
    report.twoFactors.failed.length
  if (failed > 0) process.exitCode = 1
} finally {
  await closeDb()
}
