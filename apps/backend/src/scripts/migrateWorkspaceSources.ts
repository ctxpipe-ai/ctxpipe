/**
 * A thin wrapper of upgrade step 1 (ADR-050, ADR-053): the move of the
 * connection settings and the org repositories into the sources of each
 * Workspace of one org.
 *
 *   bun run src/scripts/migrateWorkspaceSources.ts --org <orgId> [--apply]
 *
 * Without --apply it prints the plan of the source migration only. With
 * --apply it starts the Workspace upgrade of each Workspace, as the
 * "Open upgrade PR" button in the Workspace settings does. The upgrade opens
 * a pull request; it never pushes to the default branch. It prints the
 * result as JSON.
 */
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { GIT_UPGRADE_STEPS } from "../domain/upgrades/registry.js"
import { scanWorkspaceUpgrade } from "../domain/upgrades/scan.js"
import { startWorkspaceUpgrade } from "../domain/upgrades/start.js"
import { planOrgSourceMigration } from "../domain/workspace-sources/migration.js"
import { listOrgWorkspaces } from "../models/workspaces.js"
import { initEvlog, log } from "../observability/logger.js"
import { closeOpenWorkflowClient } from "../openworkflow/client.js"

initEvlog()
const args = process.argv.slice(2)
const orgId = args[args.indexOf("--org") + 1]
if (!args.includes("--org") || !orgId) {
  log.error({
    step: "migrate_workspace_sources",
    message: "Usage: --org <orgId> [--apply]",
  })
  process.exit(2)
}
const env = parseEnv(process.env)
initDb(env.DATABASE_URL)
try {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: orgId } },
  })
  if (!org) throw new Error("Organization not found")
  const report = await withOrgIdContext(org, async () => {
    if (!args.includes("--apply")) return planOrgSourceMigration({ orgId, env })
    const upgrades = []
    for (const workspace of await listOrgWorkspaces(orgId)) {
      const scanned = await scanWorkspaceUpgrade({
        orgId,
        workspace,
        steps: GIT_UPGRADE_STEPS,
        env,
      })
      upgrades.push({
        workspaceId: workspace.id,
        scanned,
        started:
          scanned.kind === "pending"
            ? await startWorkspaceUpgrade({
                orgId,
                workspaceId: workspace.id,
                key: scanned.key,
                userId: "cli:migrate-workspace-sources",
              })
            : null,
      })
    }
    return { upgrades }
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await closeOpenWorkflowClient()
  await closeDb()
}
