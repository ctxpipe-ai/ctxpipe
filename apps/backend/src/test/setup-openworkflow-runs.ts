import { afterAll } from "vitest"
import { cancelOpenWorkflowRunsSince } from "./open-workflow-runs.js"

// Contract files leave open runs in the shared "default" namespace (sweeps,
// Workspace base builds, orchestrators, and runs enqueued through the
// module-level `ow` client). A worker claims every open run in its
// namespace, so the next file's worker must work through them first. When a
// file ends, its open runs are canceled. The start time has a margin because
// the database clock can differ from the host clock; a run that an earlier
// file left in that margin is canceled too.
const since = new Date(Date.now() - 60_000)

// This hook is registered first, so it runs after the file's own hooks.
afterAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return
  // The cleanup is best effort: a file without a usable database still passes.
  await cancelOpenWorkflowRunsSince(databaseUrl, since).catch(() => undefined)
})
