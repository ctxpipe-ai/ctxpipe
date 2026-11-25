// The config path for org features (CTX-1424): sets one feature of one org.
// Usage: bun run apps/backend/src/db/set-org-feature.ts <org id> <feature> <value>
// The hosted stack runs it as a one-off task for each entry of its private
// config. It does not change a value that an operator set with the
// `admin.set-org-feature` job until the config names that value (CTX-1646).
// For `knowledge_plane`, each run also queues the backfill of the org
// (CTX-1643): the first projection of each Workspace that is not ready.
// Never put an org id in this repository.
import { parseArgs } from "node:util"

import { setOrgFeature } from "../models/org-features.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"
import { closeDb, initDb } from "./client.js"

try {
  initEvlog()
} catch {
  // A one-off task gives no app env (AUTH_SECRET). Logs then keep the evlog
  // defaults, as in migrate.ts.
}

let exitCode = 0
try {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [orgId, feature, value] = positionals
  if (!orgId || !feature || !value || positionals.length !== 3)
    throw new Error("Usage: set-org-feature.ts <org id> <feature> <value>")
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  initDb(url)
  await setOrgFeature(orgId, feature, value)
  if (feature === "knowledge_plane") {
    // A dynamic import: the OpenWorkflow client connects when it loads, and
    // it needs DATABASE_URL.
    const { backfillKnowledgePlane } =
      await import("../knowledge-plane/backfill.js")
    const { closeOpenWorkflowClient } =
      await import("../openworkflow/client.js")
    try {
      await backfillKnowledgePlane(orgId)
    } finally {
      await closeOpenWorkflowClient()
    }
  }
} catch (error) {
  exitCode = 1
  log.error({
    step: "org_features.set",
    message: "[set-org-feature] failed",
    error: error instanceof Error ? error.message : String(error),
  })
} finally {
  await closeDb()
}
await flushEvlog()
process.exit(exitCode)
