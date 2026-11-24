import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  resolveRepositoryReadTip,
  workspaceGitRead,
} from "../../domain/workspaces/resolve-revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import { withSandboxLockIfFree } from "../../domain/workspaces/sandbox-lock-store.js"
import { cleanUpKnowledgePlane } from "../../knowledge-plane/cleanup.js"
import { projectKnowledgePlane } from "../../knowledge-plane/writer.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import {
  deleteBranchHead,
  listBranchHeads,
  readyKnowledgeHeads,
} from "../../models/knowledge-state.js"
import { getOrgFeature } from "../../models/org-features.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { enqueueWorkflow } from "../client.js"
import { StepCrashLoopError, withCrashLoopGuard } from "../crash-loop.js"
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
 * time, for all its branches (ADR-071 decision 7).
 *
 * A run is for one branch (`branch`; absent: the default branch). The
 * default branch gets a full tree, each other branch an overlay (ADR-071
 * decision 3). A branch that Git no longer has loses its head, and the
 * cleanup of the same run deletes its tree rows (decision 10). Only a run
 * of the default branch queues maintenance (decision 9). The first run of a
 * new default branch (a rename) queues a run of each other branch, so that
 * each overlay gets the merge base with it (decision 11).
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
        /** The branch of the run; absent: the default branch. */
        branch: z.string().min(1).optional(),
        /**
         * Rebuild the tree of the default branch in full from Git
         * (`rebuildKnowledgePlane`, ADR-067 decision 8). Ignored for another
         * branch.
         */
        rebuild: z.boolean().optional(),
      })
      .strict(),
    logFields: (input) => ({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.rebuild ? { rebuild: true } : {}),
    }),
  },
  async ({ input, step, run }) => {
    // A projection that stops its worker (out of memory) leaves its step
    // attempt `running`, and the next worker claims the run again: one run
    // stopped a production worker about 80 times (CTX-1616). After
    // MAX_CRASHED_STEP_ATTEMPTS such stops, the guard ends the step with the
    // count, and the run fails below, with no step retry. The next hydrate or
    // push queues a new run, which has its own count.
    const name = "project-knowledge-plane"
    const guarded =
      <T>(fn: () => Promise<T>) =>
      () =>
        withCrashLoopGuard<T | { crashLoop: number }>(
          run.id,
          name,
          fn,
          (error) => ({ crashLoop: error.crashes }),
        )
    const project = (lockSignal: AbortSignal) =>
      step.run(
        {
          name,
          retryPolicy: {
            initialInterval: "10s",
            backoffCoefficient: 2,
            maximumInterval: "5m",
            maximumAttempts: 6,
          },
        },
        guarded(async () => {
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
          const key = { orgId: input.orgId, workspaceId: input.workspaceId }
          const defaultBranch = workspace.desiredDefaultBranch
          const branch = input.branch ?? defaultBranch
          const isDefault = branch === defaultBranch
          const remote = {
            url: workspace.workspaceRepositoryUrl,
            connectionId: workspace.githubConnectionId,
          }
          // The tip of a branch that is not the default branch comes from
          // Git; null when Git no longer has the branch.
          const tip = isDefault
            ? workspace.desiredSha
            : ((
                await resolveRepositoryReadTip({
                  orgId: input.orgId,
                  env,
                  remote,
                  branch,
                })
              )?.sha ?? null)
          const before = (
            await readyKnowledgeHeads(input.orgId, [input.workspaceId])
          ).get(input.workspaceId)
          const store = createKnowledgeStore(env.CLICKHOUSE_URL)
          try {
            // A removed branch loses its head. The head of the default
            // branch of the reads stays until a run of the new default
            // branch moves its own head (a rename).
            const summary = tip
              ? await projectKnowledgePlane({
                  ...key,
                  remote: workspaceGitRead({ orgId: input.orgId, env, remote }),
                  root: workspaceRootPath(workspace),
                  branch,
                  tip,
                  defaultTip: isDefault ? null : workspace.desiredSha,
                  store,
                  observedAt: new Date(),
                  rebuild: input.rebuild,
                })
              : before?.branch === branch
                ? { mode: "waiting" as const }
                : await deleteBranchHead({ ...key, branch }).then(() => ({
                    mode: "deleted" as const,
                  }))
            // Under the same lease, so that no run uses a file version
            // while the cleanup deletes it (ADR-071 decision 10).
            await cleanUpKnowledgePlane({ ...key, store, now: new Date() })
            // After a run of the default branch: each other branch whose
            // overlay is not on this branch (after a rename, or the earlier
            // default branch itself) needs the merge base with it, and each
            // branch that waits for a base gets its run. The rows say it,
            // so a retry of this step queues them too.
            const after = (
              await readyKnowledgeHeads(input.orgId, [input.workspaceId])
            ).get(input.workspaceId)
            const others =
              isDefault && after?.branch === branch
                ? (await listBranchHeads(key))
                    .filter(
                      (row) =>
                        row.branch !== branch &&
                        (row.runStatus === "waiting" ||
                          row.baseBranch !== branch),
                    )
                    .map((row) => row.branch)
                : []
            return { tip, isDefault, summary, others }
          } finally {
            await store.close()
          }
        }),
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
    if ("crashLoop" in applied)
      throw new StepCrashLoopError(name, applied.crashLoop)
    const { tip, isDefault, others } = applied
    if (others.length > 0)
      await step.run({ name: "enqueue-branch-projections" }, async () => {
        for (const branch of others)
          await enqueueWorkflow(
            knowledgeProjection.spec,
            { orgId: input.orgId, workspaceId: input.workspaceId, branch },
            {
              idempotencyKey: `knowledge-projection:${input.workspaceId}:${branch}:${tip}`,
            },
          )
      })
    if (!isDefault || !tip) return applied
    // Also after a `current` result: a retry after a stop between
    // `completeKnowledgeRun` and the step output gives `current`. The key
    // queues one job for each tip.
    await step.run({ name: "enqueue-knowledge-maintenance" }, async () => {
      await enqueueWorkflow(
        knowledgeMaintenance.spec,
        {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          sha: tip,
        },
        {
          idempotencyKey: `knowledge-maintenance:${input.workspaceId}:${tip}`,
        },
      )
    })
    return applied
  },
)
