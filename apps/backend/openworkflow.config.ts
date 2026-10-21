import "./src/observability/register.js"
import { defineConfig } from "@openworkflow/cli"
import { initDb } from "./src/db/client.js"
import { createLogger, flushEvlog, log } from "./src/observability/logger.js"
import { shutdownOtel } from "./src/observability/otel.js"
import { parseOpenWorkflowConcurrency } from "./src/openworkflow/codesearchCapacity.js"
import { connectOpenWorkflowBackend } from "./src/openworkflow/storable-backend.js"
import { wakeParkedParents } from "./src/openworkflow/wake-parked-parents.js"
import { scheduleCodesearchCheckoutGc } from "./src/openworkflow/workflows/codesearch-checkout-gc.js"
import { scheduleSweepsForOrgsNeedingIt } from "./src/openworkflow/workflows/conversation-sandbox-sweep.js"
import { scheduleDailySourcesSync } from "./src/openworkflow/workflows/workspace-sources-daily-sync.js"
import { scheduleUpgradeScansForAllOrgs } from "./src/openworkflow/workflows/workspace-upgrade-scan.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl)
// Restart sandbox sweep chains that a failed schedule or crash left behind,
// and sweep dormant orgs (on Docker each sweep also prunes the host).
void scheduleSweepsForOrgsNeedingIt().catch((error: unknown) =>
  log.error({
    step: "conversation-sandbox-sweep-backstop",
    message: `Startup sandbox sweep failed: ${String(error)}`,
  }),
)
// Start the daily Workspace sources sync chain. The key is per day, so a
// restart on the same day queues nothing new.
void scheduleDailySourcesSync(new Date()).catch((error: unknown) =>
  log.error({
    step: "workspace-sources-daily-sync-start",
    message: `Scheduling the daily sources sync failed: ${String(error)}`,
  }),
)
// Start the hourly chain that deletes old codesearch checkouts. The key is
// per hour, so a restart in the same hour queues nothing new. The first run
// after a deploy collects every repository at once.
void scheduleCodesearchCheckoutGc(new Date()).catch((error: unknown) =>
  log.error({
    step: "codesearch-checkout-gc-start",
    message: `Scheduling the checkout collection failed: ${String(error)}`,
  }),
)
// Find the pending Workspace upgrades of each org after a deploy (ADR-053).
// The key is per org and release, so a restart on the same day queues no
// second scan. The scans only record the upgrades; each one waits for an
// owner or admin.
void scheduleUpgradeScansForAllOrgs().catch((error: unknown) =>
  log.error({
    step: "workspace-upgrade-scan-backstop",
    message: `Scheduling the upgrade scans failed: ${String(error)}`,
  }),
)
// A worker that stops between the end of a child run and the wake of its
// parent leaves the parent asleep. Wake such parents at start and every
// 5 minutes, because the old worker can stop after this one started.
const wakeParents = () =>
  void wakeParkedParents()
    .then((ids) => {
      if (ids.length)
        log.warn({
          step: "openworkflow.wake-parked-parents",
          message: `Woke ${ids.length} parent runs whose child run had ended`,
          runIds: ids.join(","),
        })
    })
    .catch((error: unknown) =>
      log.error({
        step: "openworkflow.wake-parked-parents",
        message: `Waking the parked parent runs failed: ${String(error)}`,
      }),
    )
wakeParents()
setInterval(wakeParents, 5 * 60_000).unref()

let shuttingDown = false
async function shutdownWorkerObservability() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([flushEvlog(), shutdownOtel()])
}

process.on("SIGINT", () => {
  void shutdownWorkerObservability()
})
process.on("SIGTERM", () => {
  void shutdownWorkerObservability()
})

const workerConcurrency = parseOpenWorkflowConcurrency(
  process.env.OPENWORKFLOW_CONCURRENCY,
)

const bootstrapLog = createLogger({
  component: "openworkflow-worker",
  step: "openworkflow.config-loaded",
  pid: process.pid,
  cwd: process.cwd(),
  nodeEnv: process.env.NODE_ENV,
  concurrency: workerConcurrency,
})
bootstrapLog.info("openworkflow worker config loaded")
bootstrapLog.emit()

export default defineConfig({
  backend: await connectOpenWorkflowBackend(databaseUrl),
  dirs: ["./src/openworkflow/workflows"],
  // CLI imports every *.ts under dirs; skip Vitest files (dev-only deps).
  ignorePatterns: ["**/*.test.*", "**/*.spec.*"],
  worker: {
    concurrency: workerConcurrency,
  },
})
