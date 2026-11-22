/**
 * Queue a full rebuild of the knowledge plane of one Workspace from Git
 * (ADR-067 decision 8): one `knowledge-projection` run of the default branch
 * with `rebuild: true`. Use it when the ClickHouse rows of a Workspace are
 * partly lost. A head with no tree row at all needs no person: its next run
 * rebuilds in full by itself (`empty_tree`).
 *
 * The run takes the projection lease of the Workspace, as each run does.
 * Reads use the old head until the run completes. The script refuses an org
 * whose `knowledge_plane` flag is `off`, and it logs the run that it queued.
 *
 * A run of this script in production is an ops action that a human approves.
 *
 *   bun run src/scripts/rebuildKnowledgePlane.ts --org <orgId> --workspace <workspaceId>
 */
import { parseEnv } from "../config/env.js"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import { getOrgFeature } from "../models/org-features.js"
import { getWorkspaceById } from "../models/workspaces.js"
import { initEvlog, log } from "../observability/logger.js"
import {
  closeOpenWorkflowClient,
  enqueueWorkflow,
} from "../openworkflow/client.js"
import { knowledgeProjection } from "../openworkflow/workflows/knowledge-projection.js"

initEvlog()
const args = process.argv.slice(2)
const value = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const orgId = value("--org")
const workspaceId = value("--workspace")
if (!orgId || !workspaceId) {
  log.error({
    step: "rebuild_knowledge_plane",
    message: "Usage: --org <orgId> --workspace <workspaceId>",
  })
  process.exit(2)
}
initDb(parseEnv(process.env).DATABASE_URL)
try {
  if ((await getOrgFeature(orgId, "knowledge_plane")) === "off")
    throw new Error("The knowledge_plane flag of the org is off")
  const workspace = await withOrgDbContext(orgId, () =>
    getWorkspaceById(workspaceId, orgId),
  )
  if (!workspace) throw new Error("The org has no Workspace with this id")
  const handle = await enqueueWorkflow(knowledgeProjection.spec, {
    orgId,
    workspaceId,
    rebuild: true,
  })
  log.info({
    step: "rebuild_knowledge_plane",
    message: "Queued a full rebuild of the knowledge plane",
    orgId,
    workspaceId,
    workflowRunId: handle.workflowRun.id,
  })
} catch (error) {
  log.error({
    step: "rebuild_knowledge_plane",
    message: error instanceof Error ? error.message : String(error),
    orgId,
    workspaceId,
  })
  process.exitCode = 1
} finally {
  await closeOpenWorkflowClient()
  await closeDb()
}
