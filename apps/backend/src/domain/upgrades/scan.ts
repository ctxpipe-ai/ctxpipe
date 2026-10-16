import type { Env } from "../../config/env.js"
import {
  deleteSupersededUpgradeRows,
  failStoppedUpgradeRun,
  getWorkspaceUpgradeRow,
  insertWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import type { listOrgWorkspaces } from "../../models/workspaces.js"
import { readFileAtGitSha } from "../../services/git/clone-tree.js"
import { workspaceRepositoryPath } from "../../services/git/root-folder.js"
import {
  getPullRequestState,
  listOpenPullRequestsByBranchPrefix,
  parseGithubPullNumberFromUrl,
} from "../../services/github/installation-write-client.js"
import { resolveRepositoryReadCredential } from "../workspaces/resolve-revision.js"
import { workspaceRootPath } from "../workspaces/root-path.js"
import {
  CODE_FORMAT,
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
} from "../workspaces/workspace-format.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import {
  formatUpgradeKey,
  type GitUpgradeStep,
  UPGRADE_BLOCKED_REASONS,
  UPGRADE_STATUSES,
  type UpgradeStatus,
  upgradeBranch,
  upgradeTargetFormat,
  type WorkspaceUpgradePayload,
} from "./registry.js"
import {
  estimateReingest,
  REINGEST_REQUIRES_FORMAT,
  reingestBlock,
  reingestUpgradeKey,
  workspaceSourceRepositories,
} from "./reingest.js"

type ScannedWorkspace = Awaited<ReturnType<typeof listOrgWorkspaces>>[number]

export type WorkspaceUpgradeScanResult =
  | { kind: "none"; reason: "no_steps" | "unknown_format" | "not_upgradable" }
  | { kind: "current"; format: number }
  | { kind: "pending"; key: string; status: UpgradeStatus }

/** The statuses that only the scan changes. A run or an open pull request is not one of them. */
const SCAN_OWNED: readonly UpgradeStatus[] = [
  UPGRADE_STATUSES.awaiting_operator,
  UPGRADE_STATUSES.blocked,
  UPGRADE_STATUSES.failed,
]

/**
 * The format of the Workspace. The cache is null before the first hydrate
 * that read the file (for example a projection from before the cache). Null
 * means "read the file now", not format 0. Null comes back when git cannot
 * give the file now.
 */
export async function currentWorkspaceFormat(
  orgId: string,
  workspace: ScannedWorkspace,
  env: Env,
): Promise<number | null> {
  if (workspace.formatVersion !== null) return workspace.formatVersion
  if (!workspace.desiredSha) return null
  const token = await resolveRepositoryReadCredential({
    orgId,
    env,
    remote: {
      url: workspace.workspaceRepositoryUrl,
      connectionId: workspace.githubConnectionId,
    },
  })
  const file = await readFileAtGitSha({
    url: workspace.workspaceRepositoryUrl,
    sha: workspace.desiredSha,
    path: workspaceRepositoryPath(
      workspaceRootPath(workspace),
      WORKSPACE_FORMAT_PATH,
    ),
    token,
  })
  const read = readWorkspaceFormat(
    file.kind === "bytes" ? Buffer.from(file.bytes).toString("utf8") : null,
  )
  return read.kind === "format" ? read.format : -1
}

/**
 * Find the pending git upgrade of one Workspace and record it. The scan
 * never starts an upgrade: it records `awaiting_operator`, or `blocked` when
 * ctx| cannot write to the repository. It makes the row again from git (the
 * format file and an open pull request on the upgrade branch), so a lost
 * row comes back.
 */
export async function scanWorkspaceUpgrade(input: {
  orgId: string
  workspace: ScannedWorkspace
  steps: readonly GitUpgradeStep[]
  /** {@link currentWorkspaceFormat}: the scan reads it once for each Workspace. */
  format: number | null
  env: Env
}): Promise<WorkspaceUpgradeScanResult> {
  const { workspace, format } = input
  const targetFormat = upgradeTargetFormat(input.steps)
  if (targetFormat === 0) return { kind: "none", reason: "no_steps" }
  if (format === null) return { kind: "none", reason: "unknown_format" }
  // A file that is not valid, or a format that is newer than this code,
  // gets no upgrade (ADR-053 section 3).
  if (format < 0 || format > CODE_FORMAT)
    return { kind: "none", reason: "not_upgradable" }
  const key = formatUpgradeKey(targetFormat)
  await failStoppedUpgradeRun(workspace.id, key)
  const existing = await getWorkspaceUpgradeRow(workspace.id, key)
  if (format >= targetFormat) {
    if (existing && existing.status !== UPGRADE_STATUSES.completed)
      await transitionWorkspaceUpgradeRow({
        workspaceId: workspace.id,
        key,
        from: Object.values(UPGRADE_STATUSES).filter(
          (status) => status !== UPGRADE_STATUSES.completed,
        ),
        to: UPGRADE_STATUSES.completed,
        upgrade: { note: undefined, blockedReason: undefined },
      })
    return { kind: "current", format }
  }
  await deleteSupersededUpgradeRows({
    workspaceId: workspace.id,
    key,
    statuses: SCAN_OWNED,
  })
  const branch = upgradeBranch(targetFormat)
  const base = { key, fromFormat: format, targetFormat, branch }
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(
    workspace.workspaceRepositoryUrl,
  )
  const github =
    repositoryName && workspace.githubConnectionId
      ? {
          orgId: input.orgId,
          env: input.env,
          repositoryName,
          githubConnectionId: workspace.githubConnectionId,
        }
      : null
  const record = async (
    status: UpgradeStatus,
    from: readonly UpgradeStatus[],
    upgrade: Parameters<typeof transitionWorkspaceUpgradeRow>[0]["upgrade"],
  ): Promise<WorkspaceUpgradeScanResult> => {
    if (!existing)
      await insertWorkspaceUpgradeRow({
        workspaceId: workspace.id,
        generation: workspace.desiredGeneration,
        status,
        upgrade: { ...base, ...upgrade } as typeof base,
      })
    else
      await transitionWorkspaceUpgradeRow({
        workspaceId: workspace.id,
        key,
        from,
        to: status,
        generation: workspace.desiredGeneration,
        upgrade: { ...base, ...upgrade },
      })
    return {
      kind: "pending",
      key,
      status:
        (await getWorkspaceUpgradeRow(workspace.id, key))?.status ?? status,
    }
  }
  // A run in progress records its own result.
  if (
    existing?.status === UPGRADE_STATUSES.queued ||
    existing?.status === UPGRADE_STATUSES.running
  )
    return { kind: "pending", key, status: existing.status }
  const [open] = github
    ? await listOpenPullRequestsByBranchPrefix({
        ...github,
        branchPrefix: branch,
        exactBranch: branch,
      })
    : []
  if (open)
    return record(
      UPGRADE_STATUSES.pr_open,
      [...SCAN_OWNED, UPGRADE_STATUSES.pr_open],
      {
        prUrl: open.pullUrl,
        prNumber: parseGithubPullNumberFromUrl(open.pullUrl),
        note: undefined,
        blockedReason: undefined,
      },
    )
  if (existing?.status === UPGRADE_STATUSES.pr_open) {
    const number = existing.upgrade.prNumber
    const pull =
      github && number !== undefined
        ? await getPullRequestState({ ...github, pullNumber: number })
        : null
    // After a merge, the next hydrate records the new format and a scan
    // completes the row.
    if (pull?.prState === "merged")
      return { kind: "pending", key, status: existing.status }
    return record(
      UPGRADE_STATUSES.awaiting_operator,
      [UPGRADE_STATUSES.pr_open],
      {
        prUrl: undefined,
        prNumber: undefined,
        note: `The upgrade pull request${number !== undefined ? ` #${number}` : ""} closed without a merge. Start the upgrade again to open a new pull request.`,
      },
    )
  }
  // The stored probe result with the format gate: `read_only` is a known
  // denial. `unknown` waits for the tip check; the run checks again.
  if (!github || workspace.writeStatus === "read_only")
    return record(UPGRADE_STATUSES.blocked, SCAN_OWNED, {
      blockedReason: UPGRADE_BLOCKED_REASONS.writeAccess,
      note:
        workspace.readOnlyReason ??
        "Connect the Workspace repository with the GitHub App, so that ctx| can open the upgrade pull request.",
    })
  // A failed run waits for the operator to start it again.
  if (existing?.status === UPGRADE_STATUSES.failed)
    return { kind: "pending", key, status: existing.status }
  // Keep the note of a waiting row, for example a closed pull request.
  if (existing?.status === UPGRADE_STATUSES.awaiting_operator)
    return record(
      UPGRADE_STATUSES.awaiting_operator,
      [UPGRADE_STATUSES.awaiting_operator],
      {},
    )
  return record(
    UPGRADE_STATUSES.awaiting_operator,
    [UPGRADE_STATUSES.blocked],
    {
      blockedReason: undefined,
      note: undefined,
    },
  )
}

/**
 * Find the fresh re-ingestion of one Workspace and record it (ADR-053
 * section 5, G1). Every Workspace with a GitHub source repository needs it
 * once for each skill bundle: the key names the bundle, so a completed row
 * keeps it done until a release ships a new bundle. The scan never starts
 * it. It records `awaiting_operator` with the estimate, or `blocked` with
 * the reason of {@link reingestBlock}. A format that the scan cannot read now
 * leaves the row as it is, and a format that is newer than this code gets no
 * re-ingestion.
 */
export async function scanWorkspaceReingest(input: {
  orgId: string
  workspace: ScannedWorkspace
  bundle: { name: string; skills: readonly string[] }
  /** {@link currentWorkspaceFormat}: the scan reads it once for each Workspace. */
  format: number | null
}): Promise<WorkspaceUpgradeScanResult> {
  const { workspace, format } = input
  const repositories = await workspaceSourceRepositories(
    input.orgId,
    workspace.id,
  )
  if (!repositories.length) return { kind: "none", reason: "not_upgradable" }
  if (format === null) return { kind: "none", reason: "unknown_format" }
  if (format > CODE_FORMAT) return { kind: "none", reason: "not_upgradable" }
  const key = reingestUpgradeKey(input.bundle.name)
  await failStoppedUpgradeRun(workspace.id, key)
  await deleteSupersededUpgradeRows({
    workspaceId: workspace.id,
    key,
    statuses: SCAN_OWNED,
  })
  const existing = await getWorkspaceUpgradeRow(workspace.id, key)
  if (existing && !SCAN_OWNED.includes(existing.status))
    return { kind: "pending", key, status: existing.status }
  const blocked = reingestBlock({ ...workspace, format })
  const estimate = await estimateReingest({
    orgId: input.orgId,
    repositories,
    bundleSkills: input.bundle.skills,
  })
  const fields = {
    estimate,
    fromFormat: Math.max(format, 0),
    blockedReason: blocked?.blockedReason,
    // A failed run keeps its note; a block replaces it.
    ...(blocked
      ? { note: blocked.note }
      : existing?.status === UPGRADE_STATUSES.blocked
        ? { note: undefined }
        : {}),
  }
  // A failed run waits for the operator to start it again, unless it is
  // now blocked.
  const status = blocked
    ? UPGRADE_STATUSES.blocked
    : existing?.status === UPGRADE_STATUSES.failed
      ? UPGRADE_STATUSES.failed
      : UPGRADE_STATUSES.awaiting_operator
  if (!existing)
    await insertWorkspaceUpgradeRow({
      workspaceId: workspace.id,
      generation: workspace.desiredGeneration,
      status,
      upgrade: {
        key,
        targetFormat: REINGEST_REQUIRES_FORMAT,
        ...fields,
      } satisfies WorkspaceUpgradePayload,
    })
  else
    await transitionWorkspaceUpgradeRow({
      workspaceId: workspace.id,
      key,
      from: SCAN_OWNED,
      to: status,
      generation: workspace.desiredGeneration,
      upgrade: fields,
    })
  return {
    kind: "pending",
    key,
    status: (await getWorkspaceUpgradeRow(workspace.id, key))?.status ?? status,
  }
}
