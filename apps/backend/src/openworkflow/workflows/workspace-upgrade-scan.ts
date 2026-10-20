import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { readIngestSkillBundle } from "../../domain/ingestion/skill-bundle.js"
import { startAutomaticUpgrades } from "../../domain/upgrades/automatic.js"
import {
  GIT_UPGRADE_STEPS,
  type GitUpgradeStep,
  upgradeRelease,
} from "../../domain/upgrades/registry.js"
import {
  currentWorkspaceFormat,
  scanWorkspaceReingest,
  scanWorkspaceUpgrade,
} from "../../domain/upgrades/scan.js"
import { stopOrphanedReingestRuns } from "../../domain/upgrades/stop-orphans.js"
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
 * records them (ADR-053 section 6). Each upgrade waits for a click of an
 * owner or admin, except in a Workspace whose format file has
 * `upgrades: automatic`: there the scan starts it. At the end it queues one tip check for
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
      // Once for each scan: the sweep reads the runs of all orgs. A failure
      // must not stop the scan; the slot poll and the next scan try again.
      await step.run({ name: "stop-orphaned-reingest-runs" }, async () => {
        await stopOrphanedReingestRuns().catch((error: unknown) => {
          log.warn({
            event: "workspace_upgrade_orphan_sweep_failed",
            message: error instanceof Error ? error.message : String(error),
          })
        })
        return null
      })
      const scanned = await step.run({ name: "scan" }, async () => {
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })
        if (!org) return { workspaces: [], reingest: [], automatic: [] }
        return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          await withOrgDbContext(input.orgId, () =>
            ensureOrgFirstWorkspace(input.orgId),
          )
          const env = parseEnv(process.env)
          // A bundle that cannot be read fails only the re-ingestion scans.
          let bundle: ReturnType<typeof readIngestSkillBundle> | undefined
          const readBundle = () => {
            bundle ??= readIngestSkillBundle()
            return bundle
          }
          const results: Record<
            "workspaces" | "reingest" | "automatic",
            Array<{ workspaceId: string; kind: string }>
          > = { workspaces: [], reingest: [], automatic: [] }
          for (const workspace of await withOrgDbContext(input.orgId, () =>
            listOrgWorkspaces(input.orgId),
          )) {
            // Both scans use one read of the format, so GitHub gets one read.
            let format: Promise<number | null> | undefined
            const readFormat = () => {
              format ??= currentWorkspaceFormat(input.orgId, workspace, env)
              return format
            }
            const scans = {
              workspaces: async () =>
                scanWorkspaceUpgrade({
                  orgId: input.orgId,
                  workspace,
                  steps,
                  format: await readFormat(),
                  env,
                }),
              reingest: async () =>
                scanWorkspaceReingest({
                  orgId: input.orgId,
                  workspace,
                  bundle: await readBundle(),
                  format: await readFormat(),
                  env,
                }),
            }
            for (const [upgrade, scan] of Object.entries(scans) as Array<
              [keyof typeof scans, () => Promise<{ kind: string }>]
            >) {
              // One Workspace that GitHub cannot read must not stop the others.
              try {
                results[upgrade].push({
                  workspaceId: workspace.id,
                  ...(await scan()),
                })
              } catch (error) {
                log.warn({
                  event: "workspace_upgrade_scan_failed",
                  workspaceId: workspace.id,
                  upgrade,
                  message:
                    error instanceof Error ? error.message : String(error),
                })
                results[upgrade].push({
                  workspaceId: workspace.id,
                  kind: "error",
                })
              }
            }
            // A Workspace with `upgrades: automatic` starts its waiting items
            // with no click (CTX-894).
            try {
              const started = await startAutomaticUpgrades({
                orgId: input.orgId,
                workspace,
                env,
              })
              if (started.length)
                results.automatic.push({
                  workspaceId: workspace.id,
                  kind: started.join(","),
                })
            } catch (error) {
              log.warn({
                event: "workspace_upgrade_automatic_start_failed",
                workspaceId: workspace.id,
                message: error instanceof Error ? error.message : String(error),
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
      return scanned
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
  const release =
    input.release ??
    upgradeRelease(GIT_UPGRADE_STEPS, (await readIngestSkillBundle()).name)
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
 * A release with no git step still scans: a new skill bundle offers a new
 * re-ingestion.
 */
export async function scheduleUpgradeScansForAllOrgs(
  input: {
    now?: Date
    steps?: readonly GitUpgradeStep[]
    bundleName?: string
  } = {},
): Promise<number> {
  const now = input.now ?? new Date()
  const release = upgradeRelease(
    input.steps ?? GIT_UPGRADE_STEPS,
    input.bundleName ?? (await readIngestSkillBundle()).name,
  )
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
