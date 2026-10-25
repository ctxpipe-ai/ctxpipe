import { z } from "zod"

import {
  collectAllCheckouts,
  type PublishedRebuild,
} from "../../domain/codesearchCheckoutGc.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { repositoryIndex } from "./repository-index.js"

/**
 * The hourly collection of old codesearch checkouts (CTX-973): each run
 * deletes the clones, SCIP files, Zoekt shards, and rows of the checkout keys
 * that no reader needs (`collectAllCheckouts`). Each run first queues the run
 * of the next hour, so a failure later in the run does not stop the chain.
 * The worker start queues the run of the current hour, which starts the
 * chain again after a lost schedule and collects once after each deploy.
 * A repository whose published checkout codesearch no longer has (after the
 * codesearch cache reset) gets a codesearch-only index of its published
 * revision: no knowledge ingestion and no model cost.
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
    const result = await step.run({ name: "collect" }, () =>
      collectAllCheckouts(),
    )
    await step.run({ name: "rebuild-published" }, () =>
      startPublishedRebuilds(result.rebuilds, input.hour),
    )
    return result
  },
)

/**
 * Queues one codesearch-only `repository-index` run for each published
 * revision that codesearch lost. The key of the hour lets a later hour try a
 * failed index again.
 */
export async function startPublishedRebuilds(
  rebuilds: PublishedRebuild[],
  hour: string,
): Promise<void> {
  for (const { orgId, repositoryId, sha } of rebuilds)
    await runWorkflowWithWorkerWake(
      repositoryIndex.spec,
      {
        orgId,
        repositoryId,
        targetHash: sha,
        ingestionV2: true,
        rebuild: true,
      },
      {
        idempotencyKey: `repository-index-rebuild:${repositoryId}:${sha}:${hour}`,
      },
    )
}

/** Queue the run of the UTC hour of `at`, to start at `at`. */
export async function scheduleCodesearchCheckoutGc(at: Date): Promise<void> {
  const hour = at.toISOString().slice(0, 13)
  await runWorkflowWithWorkerWake(
    codesearchCheckoutGc.spec,
    { hour },
    { availableAt: at, idempotencyKey: `codesearch-checkout-gc:${hour}` },
  )
}
