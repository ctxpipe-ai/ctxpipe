import { afterAll } from "vitest"
import { cancelOpenWorkflowRunsSince } from "./open-workflow-runs.js"

// Contract files leave open runs in the shared "default" namespace. Examples
// are sweeps, Workspace base builds, orchestrators, and runs enqueued through
// the module-level `ow` client. A worker claims every open run in its
// namespace, so the next file's worker must work through them first. When a
// file ends, the cleanup cancels the open runs that the file started. `since`
// is the file start, so a dev server's runs on a shared DATABASE_URL stay
// safe.
const since = new Date()

// This hook is registered first, so it runs after the file's own hooks.
afterAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return
  // The cleanup is best effort: a file without a usable database still passes.
  await cancelOpenWorkflowRunsSince(databaseUrl, since).catch((error) =>
    console.warn("Could not cancel the open OpenWorkflow runs", error),
  )
})
