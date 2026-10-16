import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  GIT_UPGRADE_STEPS,
  type GitUpgradeStep,
  upgradeRelease,
  upgradeTargetFormat,
} from "../../domain/upgrades/registry.js"
import { scanWorkspaceUpgrade } from "../../domain/upgrades/scan.js"
import {
  ensureOrgFirstWorkspace,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueWorkspaceTipCheck } from "../enqueue-workspace-tip-check.js"

export const workspaceUpgradeScanInputSchema = z
  .object({
    orgId: z.string().min(1),
    /** {@link upgradeRelease} of the code that queued the scan. */
    release: z.string().min(1),
    /** What queued the scan. It names the tip check that the scan queues. */
    trigger: z.string().min(1),
  })
  .strict()

/**
 * Build the scan workflow for a list of steps. Production uses
 * {@link GIT_UPGRADE_STEPS}; a test gives its own steps under the same name.
 *
 * The scan finds the pending upgrades of each Workspace of one org and
 * records them (ADR-053 section 6). It starts no upgrade: each upgrade waits
 * for a click of an owner or admin. At the end it queues one tip check for
 * the org. The tip check probes write access, resumes the write jobs that
 * waited for it (also the jobs that the format gate held), and queues the
 * hydrate of a new commit, which records the format again.
 */
export function defineWorkspaceUpgradeScan(steps: readonly GitUpgradeStep[]) {
  return defineWorkflow(
    {
      name: "workspace-upgrade-scan",
      schema: workspaceUpgradeScanInputSchema,
    },
    async ({ input: queuedInput, step }) => {
      const input = workspaceUpgradeScanInputSchema.parse(queuedInput)
      const scanned = await step.run({ name: "scan" }, async () => {
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })
        if (!org) return []
        return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          await withOrgDbContext(input.orgId, () =>
            ensureOrgFirstWorkspace(input.orgId),
          )
          const env = parseEnv(process.env)
          const results = []
          for (const workspace of await withOrgDbContext(input.orgId, () =>
            listOrgWorkspaces(input.orgId),
          )) {
            // One Workspace that GitHub cannot read must not stop the others.
            try {
              results.push({
                workspaceId: workspace.id,
                ...(await scanWorkspaceUpgrade({
                  orgId: input.orgId,
                  workspace,
                  steps,
                  env,
                })),
              })
            } catch (error) {
              log.warn({
                event: "workspace_upgrade_scan_failed",
                workspaceId: workspace.id,
                message: error instanceof Error ? error.message : String(error),
              })
              results.push({
                workspaceId: workspace.id,
                kind: "error" as const,
              })
            }
          }
          return results
        })
      })
      await step.run({ name: "enqueue-tip-check" }, () =>
        enqueueWorkspaceTipCheck(
          input.orgId,
          {
            error: (error) => {
              throw error
            },
          },
          {
            idempotencyKey: `upgrade-scan-tip:${input.orgId}:${input.release}:${input.trigger}`,
          },
        ),
      )
      return { workspaces: scanned }
    },
  )
}

export const workspaceUpgradeScan =
  defineWorkspaceUpgradeScan(GIT_UPGRADE_STEPS)

/**
 * Queue the scan of one org. `trigger` makes the run unique: the same
 * trigger in the same release queues no second scan.
 */
export async function enqueueWorkspaceUpgradeScan(input: {
  orgId: string
  trigger: string
  availableAt?: Date
  release?: string
}): Promise<void> {
  const release = input.release ?? upgradeRelease()
  await runWorkflowWithWorkerWake(
    workspaceUpgradeScan.spec,
    { orgId: input.orgId, release, trigger: input.trigger },
    {
      idempotencyKey: `upgrade-scan:${input.orgId}:${release}:${input.trigger}`,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
  )
}

/** The time between the worker-start scans of two orgs. */
const SCAN_STAGGER_MS = 15_000

/**
 * Backstop on worker start: queue one scan for each org that has a
 * Workspace, once for each release. The scans start one after the other, so
 * the tip checks and the first hydrates of a deploy do not all start at once.
 * With no registered step there is nothing to find, so nothing is queued.
 */
export async function scheduleUpgradeScansForAllOrgs(
  input: { now?: Date; steps?: readonly GitUpgradeStep[] } = {},
): Promise<number> {
  const steps = input.steps ?? GIT_UPGRADE_STEPS
  if (upgradeTargetFormat(steps) === 0) return 0
  const now = input.now ?? new Date()
  const release = upgradeRelease(steps)
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.id)
  let index = 0
  for (const { id: orgId } of orgs) {
    try {
      // RLS shows the Workspaces of an org only in its own context.
      const workspaces = await withOrgDbContext(orgId, () =>
        listOrgWorkspaces(orgId),
      )
      if (!workspaces.length) continue
      await enqueueWorkspaceUpgradeScan({
        orgId,
        trigger: "worker-start",
        release,
        availableAt: new Date(now.getTime() + index * SCAN_STAGGER_MS),
      })
      index += 1
    } catch (error) {
      log.error({
        step: "workspace-upgrade-scan-backstop",
        message: `Queueing the upgrade scan failed: ${String(error)}`,
        orgId,
      })
    }
  }
  return index
}
