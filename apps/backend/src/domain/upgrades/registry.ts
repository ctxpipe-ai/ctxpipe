import { CODE_FORMAT } from "../workspaces/workspace-format.js"

/**
 * The upgrades of a Workspace repository, in code (ADR-053 section 4).
 *
 * A git upgrade step N changes the layout from format N-1 to format N. All
 * pending steps of a Workspace go into one pull request on the branch
 * `ctxpipe/upgrade/format-<target>`, with one commit for each step that
 * changes a file. The last commit of the pull request writes
 * `.ctxpipe/workspace.yaml`. Nothing starts a step automatically: the scan
 * records the pending upgrade, and an org owner or admin starts it.
 */

/** A read-only view of the Workspace tree. Paths are relative to the Workspace root folder. */
export type UpgradeTreeReader = {
  /** Every file path of the tree, sorted. */
  paths(): readonly string[]
  /** The UTF-8 text of a file, or null when the tree has no such file. */
  read(path: string): Promise<string | null>
}

export type UpgradeStepContext = {
  orgId: string
  workspaceId: string
  /** The commit of the default branch that the pull request starts from. */
  baseSha: string
}

/** The change that one step makes. Paths are relative to the Workspace root folder. */
export type UpgradeStepPlan = {
  writes: Array<{ path: string; content: string }>
  deletes: string[]
  /** Lines for the pull request body, for example an entry that the step could not move. */
  report: string[]
}

export type GitUpgradeStep = {
  /** The format that this step gives. Steps are contiguous from 1. */
  format: number
  /** A short title for the commit and the pull request. */
  title: string
  /**
   * Plan the change from the tree that the step before made. The function
   * reads only the tree and the database, and it writes nothing. A second
   * plan on its own output must give no change.
   */
  plan(
    tree: UpgradeTreeReader,
    ctx: UpgradeStepContext,
  ): Promise<UpgradeStepPlan>
}

/**
 * The registered git upgrade steps. CTX-743 adds step 1 (export and
 * sources); CTX-744 adds steps 2 and 3. Until a step is registered, the scan
 * offers no upgrade to its format, so no pull request can claim a format
 * whose layout change did not run.
 */
export const GIT_UPGRADE_STEPS: readonly GitUpgradeStep[] = []

/** The prefix of every upgrade branch. Only the upgrade workflow pushes to it. */
export const UPGRADE_BRANCH_PREFIX = "ctxpipe/upgrade/"

/** The statuses of a `workspace_write_jobs` row of kind `upgrade`. */
export const UPGRADE_STATUSES = {
  /** The scan found the upgrade. It waits for a click of an owner or admin. */
  awaiting_operator: "awaiting_operator",
  /** An owner or admin started it. The workflow did not claim it yet. */
  queued: "queued",
  running: "running",
  /** The pull request is open. A merge completes the upgrade. */
  pr_open: "pr_open",
  completed: "completed",
  failed: "failed",
  /** It cannot start, for example because ctx| cannot write to the repository. */
  blocked: "blocked",
} as const

export type UpgradeStatus =
  (typeof UPGRADE_STATUSES)[keyof typeof UPGRADE_STATUSES]

export const UPGRADE_BLOCKED_REASONS = {
  /** ctx| cannot push a branch or open a pull request on the repository. */
  writeAccess: "write_access",
  /** The re-ingestion needs format 3 or higher (G5). Merge the format upgrade first. */
  needsFormat: "needs_format",
  /** This deployment has no ingest sandbox runtime. */
  sandboxUnavailable: "sandbox_unavailable",
  /** Ingestion v2 does not publish to this Workspace (`ingestionV2EnabledFor`), for example because its format is not read yet. */
  ingestionV2Off: "ingestion_v2_off",
} as const

export type UpgradeBlockedReason =
  (typeof UPGRADE_BLOCKED_REASONS)[keyof typeof UPGRADE_BLOCKED_REASONS]

/** The write job kind of an upgrade run. */
export const UPGRADE_JOB_KIND = "upgrade"

/**
 * The highest format that the registered steps reach without a gap. A
 * registry with a gap or a step above {@link CODE_FORMAT} is a programming
 * error, so this throws.
 */
export function upgradeTargetFormat(
  steps: readonly GitUpgradeStep[] = GIT_UPGRADE_STEPS,
): number {
  steps.forEach((step, index) => {
    if (step.format !== index + 1)
      throw new Error(
        `Upgrade step ${index + 1} is missing or out of order (found format ${step.format})`,
      )
    if (step.format > CODE_FORMAT)
      throw new Error(
        `Upgrade step ${step.format} is above the code format ${CODE_FORMAT}`,
      )
  })
  return steps.length
}

/** The steps that take a repository from `fromFormat` to `targetFormat`, in order. */
export function pendingUpgradeSteps(
  steps: readonly GitUpgradeStep[],
  fromFormat: number,
  targetFormat: number,
): GitUpgradeStep[] {
  upgradeTargetFormat(steps)
  return steps.filter(
    (step) => step.format > fromFormat && step.format <= targetFormat,
  )
}

/** The key of the git upgrade to `targetFormat`. */
export function formatUpgradeKey(targetFormat: number): string {
  return `format-${targetFormat}`
}

/** The target format of a git upgrade key, or null for another key. */
export function targetFormatOfKey(key: string): number | null {
  const match = /^format-([1-9][0-9]{0,8})$/.exec(key)
  return match?.[1] ? Number(match[1]) : null
}

/** The branch of the pull request that upgrades to `targetFormat`. */
export function upgradeBranch(targetFormat: number): string {
  return `${UPGRADE_BRANCH_PREFIX}${formatUpgradeKey(targetFormat)}`
}

/** The deterministic id of the upgrade row of a Workspace. A second insert does nothing. */
export function upgradeJobId(workspaceId: string, key: string): string {
  return `wju_${workspaceId}_${key}`
}

/**
 * Names the set of upgrades that this code knows: the git steps and the
 * ingest skill bundle (`bundleName`) that the re-ingestion offers. The
 * worker-start scan runs once for each org and release, so a release with a
 * new step or a new bundle scans again.
 */
export function upgradeRelease(
  steps: readonly GitUpgradeStep[],
  bundleName: string,
): string {
  return `code-${CODE_FORMAT}.steps-${upgradeTargetFormat(steps)}.${bundleName}`
}

/**
 * The typed payload of an upgrade row (`workspace_write_jobs.payload.upgrade`).
 * The row is a cache of git and a run log: the scan makes it again from the
 * format file and the open pull requests.
 */
export type WorkspaceUpgradePayload = {
  key: string
  fromFormat: number
  /** The format that the upgrade gives; on a re-ingestion, the format that it needs. */
  targetFormat: number
  /** Only on a git upgrade: the pull request branch. */
  branch?: string
  prNumber?: number
  prUrl?: string
  /** The user id of the owner or admin who started the upgrade. */
  approvedBy?: string
  approvedAt?: string
  blockedReason?: UpgradeBlockedReason
  /** A note for the operator, for example why a pull request closed. */
  note?: string
  /** The commits and reports of the last run, in step order. */
  steps?: Array<{
    format: number
    title: string
    sha: string | null
    report: string[]
  }>
  /** Only on a re-ingestion: the estimate that the operator saw before the click. */
  estimate?: ReingestEstimate
  /** Only on a re-ingestion: one entry for each source repository, in run order. */
  repositories?: ReingestRepositoryReport[]
  /** Only on a re-ingestion that the cost cap stopped. */
  stopReason?: "cost_cap"
}

/** A range from the p50 to the p90 value. */
export type EstimateRange = { low: number; high: number }

/**
 * The cost and time estimate of a re-ingestion (ADR-053 section 5). The UI
 * shows it before the click.
 */
export type ReingestEstimate = {
  repositories: number
  /** USD for the model calls. */
  costUsd: EstimateRange
  /** Wall time when the repositories run one after the other. */
  minutes: EstimateRange
  perRepository: Array<{
    repository: string
    roots: EstimateRange
    costUsd: EstimateRange
    minutes: EstimateRange
    /** `history`: from the last finished ingestion v2 run of the repository. */
    basis: "history" | "heuristic"
  }>
}

export type ReingestRepositoryReport = {
  /** `owner/name` on GitHub. */
  repository: string
  sha: string | null
  /** The ingestion v2 run, when it started. */
  runId: string | null
  status: "pending" | "done" | "partial" | "skipped" | "failed"
  report: string[]
  /** The model spend in USD of the ingestion run, from the usage that its steps report. */
  spendUsd?: number
}
