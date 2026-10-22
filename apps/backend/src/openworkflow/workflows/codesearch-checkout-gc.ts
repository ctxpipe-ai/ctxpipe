import { z } from "zod"
import { collectAllCheckouts } from "../../domain/codesearchCheckoutGc.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * The hourly collection of old codesearch checkouts (CTX-973): each run
 * deletes the clones, SCIP files, Zoekt shards, and rows of the checkout keys
 * that no reader needs (`collectAllCheckouts`). Each run first queues the run
 * of the next hour, so a failure later in the run does not stop the chain.
 * The worker start queues the run of the current hour, which starts the
 * chain again after a lost schedule and collects once after each deploy.
 */
export const codesearchCheckoutGc = defineWorkflow(
  {
    name: "codesearch-checkout-gc",
    schema: z.object({ hour: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/) }),
  },
  async ({ input, step }) => {
    const hourStart = Date.parse(`${input.hour}:00:00.000Z`)
    await step.run({ name: "schedule-next-hour" }, () =>
      scheduleCodesearchCheckoutGc(new Date(hourStart + 3_600_000)),
    )
    return step.run({ name: "collect" }, () => collectAllCheckouts())
  },
)

/** Queue the run of the UTC hour of `at`, to start at `at`. */
export async function scheduleCodesearchCheckoutGc(at: Date): Promise<void> {
  const hour = at.toISOString().slice(0, 13)
  await runWorkflowWithWorkerWake(
    codesearchCheckoutGc.spec,
    { hour },
    { availableAt: at, idempotencyKey: `codesearch-checkout-gc:${hour}` },
  )
}
