/**
 * Encrypts the stored secrets again with the current keys, after an operator
 * changes AUTH_SECRET or CONNECTION_SECRETS_ENCRYPTION_KEY (see the
 * self-hosting "Secrets" page).
 *
 *   bun run src/scripts/reencryptSecrets.ts [--dry-run]
 *
 * It always does all organizations. It reads the old keys from
 * CONNECTION_SECRETS_PREVIOUS_KEYS. It prints counts and the ids of the rows
 * that it cannot decrypt or write, never a value. Run it again until `failed`
 * is empty; each run skips the current values.
 */
import { parseEnv } from "../config/env.js"
import { closeDb, initDb } from "../db/client.js"
import { reencryptStoredSecrets } from "../lib/reencrypt-stored-secrets.js"
import { initEvlog, log } from "../observability/logger.js"

const args = process.argv.slice(2)
if (args.some((arg) => arg !== "--dry-run")) {
  process.stderr.write("Usage: secrets:reencrypt [--dry-run]\n")
  process.exit(2)
}
initEvlog()
const env = parseEnv(process.env)
initDb(env.DATABASE_URL)
try {
  const report = await reencryptStoredSecrets({
    env,
    dryRun: args.includes("--dry-run"),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  const failed =
    report.connections.failed.length +
    report.sandboxGitTokens.failed.length +
    report.twoFactors.failed.length
  if (failed > 0) process.exitCode = 1
} catch {
  // Do not log the error: a database error holds the bound parameters, which
  // are ciphertext.
  log.error({
    step: "secrets.reencrypt",
    message:
      "The re-encrypt command stopped. Make sure that the database is available, then run the command again.",
  })
  process.exitCode = 1
} finally {
  await closeDb()
}
