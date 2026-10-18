import {
  type GitFileMode,
  gitFileModeSchema,
} from "../../services/git/file-change.js"
import {
  type GitPack,
  nativeGit,
  packRootTree,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import {
  WORKSPACE_FORMAT_PATH,
  workspaceFormatFile,
} from "../workspaces/workspace-format.js"
import {
  type GitUpgradeStep,
  pendingUpgradeSteps,
  type UpgradeNotice,
  type UpgradeStepContext,
  type UpgradeStepPlan,
  type UpgradeTreeReader,
} from "./registry.js"

export type UpgradeStepResult = {
  format: number
  title: string
  /** The commit of the step, or null when the step changed no file. */
  sha: string | null
  report: string[]
  /** The notices of the step, each one time. A run before notices has none. */
  notices?: UpgradeNotice[]
}

/** Each notice one time, in the order of its first use. */
function uniqueNotices(notices: readonly UpgradeNotice[]): UpgradeNotice[] {
  const seen = new Set<string>()
  return notices.filter((notice) => {
    const key = `${notice.kind}\n${notice.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Run `operation` with a reader of the pack's tree below its root folder. */
async function withTreeReader<T>(
  pack: GitPack,
  operation: (tree: UpgradeTreeReader) => Promise<T>,
): Promise<T> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const tree = await packRootTree(directory, pack)
      // Each entry is "<mode> blob <sha>\t<path>".
      const modes = new Map<string, GitFileMode>()
      const blobs = new Map(
        tree
          ? (await nativeGit(directory, ["ls-tree", "-r", "-z", tree]))
              .toString()
              .split("\0")
              .filter(Boolean)
              .flatMap((entry) => {
                const tab = entry.indexOf("\t")
                const [mode, type, sha] = entry.slice(0, tab).split(" ")
                const path = entry.slice(tab + 1)
                const fileMode = gitFileModeSchema.safeParse(mode)
                if (type !== "blob" || !sha) return []
                if (fileMode.success) modes.set(path, fileMode.data)
                return [[path, sha] as const]
              })
          : [],
      )
      const paths = [...blobs.keys()].sort()
      const readBytes = async (path: string) => {
        const sha = blobs.get(path)
        return sha ? nativeGit(directory, ["cat-file", "blob", sha]) : null
      }
      return operation({
        paths: () => paths,
        blobSha: (path) => blobs.get(path) ?? null,
        read: async (path) => (await readBytes(path))?.toString() ?? null,
        readBytes,
        mode: (path) => modes.get(path) ?? null,
      })
    },
    pack,
  )
}

/** The plan without writes that change nothing and deletes of missing files. */
async function effectiveChange(
  pack: GitPack,
  step: GitUpgradeStep,
  ctx: UpgradeStepContext,
): Promise<UpgradeStepPlan> {
  return withTreeReader(pack, async (tree) => {
    const plan = await step.plan(tree, ctx)
    const touched = [...plan.writes.map((write) => write.path), ...plan.deletes]
    // Only the last commit of the pull request writes the format file.
    if (touched.includes(WORKSPACE_FORMAT_PATH))
      throw new Error(
        `Upgrade step ${step.format} must not change ${WORKSPACE_FORMAT_PATH}`,
      )
    if (new Set(touched).size !== touched.length)
      throw new Error(
        `Upgrade step ${step.format} changes the same path two times`,
      )
    const writes: UpgradeStepPlan["writes"] = []
    for (const write of plan.writes) {
      const current = await tree.readBytes(write.path)
      const content =
        write.encoding === "base64"
          ? current?.toString("base64")
          : current?.toString()
      if (
        content !== write.content ||
        (write.mode !== undefined && write.mode !== tree.mode(write.path))
      )
        writes.push(write)
    }
    const existing = new Set(tree.paths())
    return {
      writes,
      deletes: plan.deletes.filter((path) => existing.has(path)),
      report: plan.report,
      notices: uniqueNotices(plan.notices ?? []),
    }
  })
}

async function commitChange(
  pack: GitPack,
  change: Pick<UpgradeStepPlan, "writes" | "deletes">,
  input: { subject: string; createdAt: Date | string },
): Promise<GitPack> {
  const staged = await stageGitFiles(pack, change.writes, change.deletes)
  await validateGitTree(staged, [
    ...change.writes.map((write) => write.path),
    ...change.deletes,
  ])
  return commitGitTree(staged, input)
}

/**
 * Make the commits of an upgrade pull request on top of `pack`: one commit
 * for each pending step that changes a file, in format order, and then one
 * commit that writes `format: targetFormat` to the format file. Each step
 * reads the tree that the step before it made. A fixed base, step output and
 * `createdAt` give the same commits again, so a replay pushes the same SHA.
 */
export async function buildUpgradeCommits(input: {
  pack: GitPack
  steps: readonly GitUpgradeStep[]
  fromFormat: number
  targetFormat: number
  ctx: UpgradeStepContext
  createdAt: Date | string
}): Promise<{ pack: GitPack; steps: UpgradeStepResult[] }> {
  let pack = input.pack
  const results: UpgradeStepResult[] = []
  for (const step of pendingUpgradeSteps(
    input.steps,
    input.fromFormat,
    input.targetFormat,
  )) {
    const change = await effectiveChange(pack, step, input.ctx)
    if (change.writes.length || change.deletes.length) {
      pack = await commitChange(pack, change, {
        subject: `ctx| upgrade to format ${step.format}: ${step.title}`,
        createdAt: input.createdAt,
      })
      results.push({
        ...step,
        sha: pack.sha,
        report: change.report,
        notices: change.notices,
      })
    } else
      results.push({
        ...step,
        sha: null,
        report: change.report,
        notices: change.notices,
      })
  }
  const formatFile = workspaceFormatFile(input.targetFormat)
  const currentFormatFile = await withTreeReader(pack, (tree) =>
    tree.read(WORKSPACE_FORMAT_PATH),
  )
  // A run on a tree that has the target format (a check of idempotency)
  // makes no format commit.
  if (currentFormatFile !== formatFile.content)
    pack = await commitChange(
      pack,
      { writes: [formatFile], deletes: [] },
      {
        subject: `ctx| upgrade: set the Workspace format to ${input.targetFormat}`,
        createdAt: input.createdAt,
      },
    )
  return {
    pack,
    steps: results.map(({ format, title, sha, report, notices }) => ({
      format,
      title,
      sha,
      report,
      notices,
    })),
  }
}

/** The title and body of the upgrade pull request, with the report of each step. */
export function upgradePullRequestText(input: {
  fromFormat: number
  targetFormat: number
  steps: readonly UpgradeStepResult[]
}): { title: string; body: string } {
  const sections = input.steps.map((step) => {
    const lines = step.report.length
      ? step.report.map((line) => `- ${line}`)
      : [step.sha ? "- No items to report." : "- No change was necessary."]
    return [`### Format ${step.format}: ${step.title}`, ...lines].join("\n")
  })
  return {
    title: `Upgrade this ctx| Workspace to format ${input.targetFormat}`,
    body: [
      `ctx| upgrades the layout of this Workspace from format ${input.fromFormat} to format ${input.targetFormat}. Each step that changes a file has its own commit. The last commit sets \`${WORKSPACE_FORMAT_PATH}\` to \`format: ${input.targetFormat}\`.`,
      "Merge this pull request to apply the upgrade. When you close it without a merge, the upgrade waits in the Workspace settings until an owner or admin starts it again.",
      "There is one commit for each step, and a last commit that sets the format. This lets you review each step alone or revert it alone. The format commit comes last, so the files and the format cannot disagree. You can use any merge method: merge, squash, or rebase.",
      ...sections,
    ].join("\n\n"),
  }
}
