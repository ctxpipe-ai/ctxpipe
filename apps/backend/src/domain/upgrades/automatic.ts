import type { Env } from "../../config/env.js"
import { listWorkspaceUpgradeRows } from "../../models/workspace-upgrades.js"
import type { listOrgWorkspaces } from "../../models/workspaces.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  readFileAtGitSha,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import { workspaceRepositoryPath } from "../../services/git/root-folder.js"
import { resolveRepositoryReadCredential } from "../workspaces/resolve-revision.js"
import { workspaceRootPath } from "../workspaces/root-path.js"
import {
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  type WorkspaceUpgradeMode,
  withWorkspaceFormatFields,
} from "../workspaces/workspace-format.js"
import { UPGRADE_STATUSES } from "./registry.js"
import { isReingestUpgradeKey } from "./reingest.js"
import { readWorkspaceFormatFileAt } from "./scan.js"
import { startWorkspaceUpgrade } from "./start.js"

/** The `approvedBy` of an upgrade that the Workspace setting started. */
export const AUTOMATIC_UPGRADE_APPROVER = "ctxpipe:automatic-upgrades"

/**
 * Automatic upgrades on or off: write `upgrades: automatic` or
 * `upgrades: manual` into the format file of the Workspace, with a commit on
 * the default branch through the file job write path. The request names only
 * the setting: the job takes `upgrades` from it and keeps the format of the
 * tree that it commits on. The caller checks the role.
 */
export async function setUpgradeMode(
  input: {
    jobId: string
    orgId: string
    workspace: { id: string }
    mode: WorkspaceUpgradeMode
  },
  log: { error: (err: Error) => void },
): Promise<{ started: boolean }> {
  const content = withWorkspaceFormatFields(null, { upgrades: input.mode })
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
 * Why ctxpipe cannot show the upgrade setting. `no_tip`: ctxpipe has not read
 * the repository yet. `invalid_format`: the format file is not valid.
 * `unreadable`: git or the credential failed.
 */
export type UpgradeSettingReason = "no_tip" | "invalid_format" | "unreadable"

/**
 * The upgrade setting of the Workspace, from the format file at the head of
 * the default branch. The head shows a saved setting at once, before hydrate
 * moves the projected commit. Git is the source of truth, so this reads git
 * and not a cache.
 */
export async function readUpgradeSetting(
  orgId: string,
  workspace: {
    id: string
    desiredSha: string | null
    desiredDefaultBranch?: string | null
    workspaceRepositoryUrl: string
    githubConnectionId: string | null
    rootPath: string | null
  },
  env: Env,
  log: { error: (err: Error) => void },
): Promise<
  | { mode: WorkspaceUpgradeMode; reason: null }
  | { mode: null; reason: UpgradeSettingReason }
> {
  if (!workspace.desiredSha) return { mode: null, reason: "no_tip" }
  try {
    const url = workspace.workspaceRepositoryUrl
    const token = await resolveRepositoryReadCredential({
      orgId,
      env,
      remote: { url, connectionId: workspace.githubConnectionId },
    })
    const tip = await resolveGitRemoteTip({
      url,
      branch: workspace.desiredDefaultBranch,
      token,
    })
    const file = await readFileAtGitSha({
      url,
      sha: tip?.sha ?? workspace.desiredSha,
      path: workspaceRepositoryPath(
        workspaceRootPath(workspace),
        WORKSPACE_FORMAT_PATH,
      ),
      token,
    })
    const read = readWorkspaceFormat(
      file.kind === "bytes" ? Buffer.from(file.bytes).toString("utf8") : null,
    )
    return read.kind === "format"
      ? { mode: read.upgrades, reason: null }
      : { mode: null, reason: "invalid_format" }
  } catch (error) {
    // The token goes to git in a header, not in the message.
    log.error(
      new Error(
        `ctxpipe could not read the upgrade setting of Workspace ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return { mode: null, reason: "unreadable" }
  }
}

/**
 * Start each upgrade item of the Workspace that waits for an owner or admin,
 * when the format file of the Workspace has `upgrades: automatic`. A git
 * upgrade starts before a re-ingestion. A failed item waits for a person.
 * It returns the keys that it queued. Call it inside the org context.
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
