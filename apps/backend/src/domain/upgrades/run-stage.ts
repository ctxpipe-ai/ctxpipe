import { trace } from "@opentelemetry/api"
import { transitionWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { getLogger } from "../../observability/logger.js"
import { UPGRADE_STATUSES, type UpgradeRunStage } from "./registry.js"

/**
 * Run one stage of a git upgrade. The row records the stage and its start, so
 * the UI can show the progress, and a span times the stage, so a trace shows
 * which stage is slow. A failed record does not stop the run: the stage is
 * progress only.
 */
export async function runUpgradeStage<T>(
  input: {
    workspaceId: string
    key: string
    runId: string
    stage: UpgradeRunStage
  },
  work: () => Promise<T>,
): Promise<T> {
  const since = new Date().toISOString()
  await transitionWorkspaceUpgradeRow({
    workspaceId: input.workspaceId,
    key: input.key,
    from: [UPGRADE_STATUSES.running],
    to: UPGRADE_STATUSES.running,
    ownerRunId: input.runId,
    upgrade: { stage: { name: input.stage, since } },
  }).catch((error: unknown) =>
    getLogger().warn("workspace-upgrade.stage-record-failed", {
      stage: input.stage,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(
      "workspace-upgrade.stage",
      { attributes: { "ctxpipe.upgrade.stage": input.stage } },
      async (span) => {
        try {
          return await work()
        } finally {
          span.end()
        }
      },
    )
}
