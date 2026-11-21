import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import { withSandboxLockIfFree } from "../../domain/workspaces/sandbox-lock-store.js"
import { cleanUpKnowledgePlane } from "../../knowledge-plane/cleanup.js"
import { projectKnowledgePlane } from "../../knowledge-plane/writer.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { getOrgFeature } from "../../models/org-features.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { knowledgeMaintenance } from "./knowledge-maintenance.js"

/**
 * The ClickHouse projection of the knowledge plane (ADR-067), for an org
 * whose flag is not `off`. The hydrate queues one run after it releases the
 * Workspace hydrate lock. Thus a ClickHouse outage does not stop the old
 * stack, and both stacks stay current (ADR-069 decision 9).
 *
 * A run applies the tip that the Workspace wants when the step starts, not
 * the SHA of its trigger. Thus queued runs merge (ADR-067 decision 3): a
 * later run of an applied tip returns `current`, and an earlier run never
 * moves `last_sha` back. Its own lease lets one run of a Workspace run at a
 * time.
 *
 * An infrastructure error throws in the step. The step retries from the same
 * `last_sha`, and the next run starts from it too (ADR-067 decision 8). When
 * the outage is longer than the retries, the run fails, and the next hydrate
 * of the Workspace queues a new run. Until then, the lag alert shows it
 * (ADR-067 decision 11).
 */
export const knowledgeProjection = defineWorkflow(
  {
    name: "knowledge-projection",
    schema: z
      .object({
        orgId: z.string().min(1),
        workspaceId: z.string().min(1),
      })
      .strict(),
    logFields: (input) => ({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    }),
  },
  async ({ input, step }) => {
    const project = (lockSignal: AbortSignal) =>
      step.run(
        {
          name: "project-knowledge-plane",
          retryPolicy: {
            initialInterval: "10s",
            backoffCoefficient: 2,
            maximumInterval: "5m",
            maximumAttempts: 6,
          },
        },
        async () => {
          lockSignal.throwIfAborted()
          // The flag is the gate before Workspace content goes to the
          // embedding provider and to ClickHouse. A run can wait for a long
          // time, so it reads the flag again at each attempt.
          if ((await getOrgFeature(input.orgId, "knowledge_plane")) === "off")
            return null
          const env = parseEnv(process.env)
          const workspace = await withOrgDbContext(input.orgId, () =>
            getWorkspaceById(input.workspaceId, input.orgId),
          )
          // A Workspace that is gone, or that has no tip yet: its hydrate
          // queues a run when it has one.
          if (!workspace?.desiredSha || !workspace.desiredDefaultBranch)
            return null
          const tip = workspace.desiredSha
          const store = createKnowledgeStore(env.CLICKHOUSE_URL)
          try {
            const summary = await projectKnowledgePlane({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              remote: workspaceGitRead({
                orgId: input.orgId,
                env,
                remote: {
                  url: workspace.workspaceRepositoryUrl,
                  connectionId: workspace.githubConnectionId,
                },
              }),
              root: workspaceRootPath(workspace),
              branch: workspace.desiredDefaultBranch,
              tip,
              store,
              observedAt: new Date(),
            })
            // Under the same lease, so that no run uses a file version
            // while the cleanup deletes it (ADR-071 decision 10).
            await cleanUpKnowledgePlane({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              store,
              now: new Date(),
            })
            return { tip, summary }
          } finally {
            await store.close()
          }
        },
      )
    // A run that finds the lease busy sleeps and tries again. A sleeping run
    // holds no worker slot, so the runs that queue during a ClickHouse outage
    // do not take the slots of the hydrate. The run that gets the lease
    // reads the newest tip, so a later run often only finds `current`.
    const projectIfFree = () =>
      withSandboxLockIfFree(
        input.orgId,
        `knowledge-projection:${input.workspaceId}`,
        project,
      )
    let locked = await projectIfFree()
    for (let wait = 0; locked.busy; wait++) {
      await step.sleep(`await-knowledge-lease-${wait}`, "1 minute")
      locked = await projectIfFree()
    }
    const applied = locked.value
    if (!applied) return null
    // Also after a `current` result: a retry after a stop between
    // `completeKnowledgeRun` and the step output gives `current`. The key
    // queues one job for each tip.
    await step.run({ name: "enqueue-knowledge-maintenance" }, async () => {
      await enqueueWorkflow(
        knowledgeMaintenance.spec,
        {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          sha: applied.tip,
        },
        {
          idempotencyKey: `knowledge-maintenance:${input.workspaceId}:${applied.tip}`,
        },
      )
    })
    return applied
  },
)
