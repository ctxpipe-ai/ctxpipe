/**
 * Migrate the connections of one org to Workspace sources (ADR-050).
 *
 *   bun run src/scripts/migrateWorkspaceSources.ts --org <orgId> [--apply]
 *
 * Without --apply it prints the plan only. With --apply it opens one PR for
 * each Workspace repository. It prints the migration report as JSON.
 */
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { runSourceMigration } from "../domain/workspace-sources/migration.js"
import { initEvlog, log } from "../observability/logger.js"

const args = process.argv.slice(2)
const orgId = args[args.indexOf("--org") + 1]
if (!args.includes("--org") || !orgId) {
  log.error({
    step: "migrate_workspace_sources",
    message: "Usage: --org <orgId> [--apply]",
  })
  process.exit(2)
}
initEvlog()
const env = parseEnv(process.env)
initDb(env.DATABASE_URL)
try {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: orgId } },
  })
  if (!org) throw new Error("Organization not found")
  const report = await withOrgIdContext(org, () =>
    runSourceMigration({ orgId, env, apply: args.includes("--apply") }),
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await closeDb()
}
