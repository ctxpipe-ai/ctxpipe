import type { Env } from "../../config/env.js"
import { listWorkspaceUpgradeRows } from "../../models/workspace-upgrades.js"
import type { listOrgWorkspaces } from "../../models/workspaces.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  WORKSPACE_FORMAT_PATH,
  withWorkspaceFormatFields,
} from "../workspaces/workspace-format.js"
import { UPGRADE_STATUSES } from "./registry.js"
import { isReingestUpgradeKey } from "./reingest.js"
import { readWorkspaceFormatFileAt } from "./scan.js"
import { startWorkspaceUpgrade } from "./start.js"

/** The `approvedBy` of an upgrade that the Workspace setting started. */
export const AUTOMATIC_UPGRADE_APPROVER = "ctxpipe:automatic-upgrades"

/**
 * Always update: write `upgrades: automatic` into the format file of the
 * Workspace, with a commit on the default branch through the file job write
 * path. The job keeps the format of the tree that it commits on. The caller
 * checks the role.
 */
export async function enableAutomaticUpgrades(
  input: {
    jobId: string
    orgId: string
    workspace: { id: string; formatVersion: number | null }
  },
  log: { error: (err: Error) => void },
): Promise<{ started: boolean }> {
  const content = withWorkspaceFormatFields(null, {
    format: Math.max(input.workspace.formatVersion ?? 0, 0),
    upgrades: "automatic",
  })
  if (content === null) return { started: false }
  return enqueueWorkspaceWriteCommit(
    {
      jobId: input.jobId,
      orgId: input.orgId,
      workspaceId: input.workspace.id,
      kind: "ui_file_edit",
      mergeFiles: [{ path: WORKSPACE_FORMAT_PATH, content }],
      mergeDeletePaths: [],
    },
    log,
  )
}

/**
 * Start each upgrade item of the Workspace that waits for an owner or admin,
 * when the format file of the Workspace has `upgrades: automatic`. A git
 * upgrade starts before a re-ingestion. A failed item waits for a person.
 * The cost cap of a re-ingestion applies as on a click. It returns the keys
 * that it queued. Call it inside the org context.
 */
export async function startAutomaticUpgrades(input: {
  orgId: string
  workspace: Awaited<ReturnType<typeof listOrgWorkspaces>>[number]
  env: Env
}): Promise<string[]> {
  const waiting = (await listWorkspaceUpgradeRows(input.workspace.id))
    .filter((row) => row.status === UPGRADE_STATUSES.awaiting_operator)
    .sort(
      (a, b) =>
        Number(isReingestUpgradeKey(a.upgrade.key)) -
        Number(isReingestUpgradeKey(b.upgrade.key)),
    )
  if (!waiting.length) return []
  const file = await readWorkspaceFormatFileAt(
    input.orgId,
    input.workspace,
    input.env,
  )
  if (file?.kind !== "format" || file.upgrades !== "automatic") return []
  const started: string[] = []
  for (const row of waiting) {
    const result = await startWorkspaceUpgrade({
      orgId: input.orgId,
      workspaceId: input.workspace.id,
      key: row.upgrade.key,
      userId: AUTOMATIC_UPGRADE_APPROVER,
    })
    if (result.kind === "queued") started.push(row.upgrade.key)
  }
  return started
}
