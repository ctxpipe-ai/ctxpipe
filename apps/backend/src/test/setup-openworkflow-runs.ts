import { randomUUID } from "node:crypto"

import { afterAll, vi } from "vitest"

import { cancelOpenWorkflowRuns } from "./open-workflow-runs.js"

// Each test file gets its own OpenWorkflow namespace. A worker claims every
// open run of its namespace, also runs it does not implement, and waits up to
// one second after each such claim. In the shared "default" namespace, open
// runs that a dev server or an earlier file left made a file's workers reach
// their own runs too late. The shared client (`openworkflow/client.ts`) reads
// this variable when the file imports it, and tests connect their backends
// with `openWorkflowNamespaceId()`. The test policy refuses a test backend
// without a namespace.
const namespaceId = `test-${process.pid}-${randomUUID()}`
process.env.OPENWORKFLOW_NAMESPACE_ID = namespaceId

// This hook is registered first, so it runs after the file's own hooks.
afterAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return
  // A file can leave fake timers on. The database client needs real timers.
  vi.useRealTimers()
  // The cleanup is best effort. A file with a slow or unusable database
  // still passes, and the cleanup logs a warning.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("The cleanup took more than 5 seconds")),
      5_000,
    )
  })
  await Promise.race([
    cancelOpenWorkflowRuns(databaseUrl, namespaceId),
    timeout,
  ])
    .catch((error) =>
      console.warn("Could not cancel the open OpenWorkflow runs", error),
    )
    .finally(() => clearTimeout(timer))
})
