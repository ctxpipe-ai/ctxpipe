import { useQueries, useQuery } from "@tanstack/react-query"
import {
  pendingWorkspaceUpgradesOptions,
  type WorkspaceUpgradeItem,
} from "@/features/workspace-upgrades/queries"
import { upgradeCanStart } from "@/features/workspace-upgrades/upgrade-copy"
import {
  workspaceDetailOptions,
  workspaceGitTreeOptions,
} from "@/features/workspaces/queries"
import {
  skippedFilesInTree,
  workspaceTreeSha,
} from "@/features/workspaces/skipped-files"
import type {
  Workspace,
  WorkspaceSkippedFile,
} from "@/features/workspaces/types"
import { upgradeDismissKey, useUserPreferences } from "@/lib/user-preferences"

type HomeNotice = { dismissKey: string; workspace: Workspace } & (
  | { kind: "upgrade"; item: WorkspaceUpgradeItem }
  | {
      kind: "problem"
      skippedFiles: WorkspaceSkippedFile[]
      /** The paths that the chat checkout holds and that the agent can fix. */
      fixable: ReadonlySet<string>
    }
)

/**
 * The Home notices (CTX-894, CTX-915): the hydrate problems of each
 * Workspace (the skipped files that Workspace settings shows), then the
 * upgrade items that an owner or admin can start. They are split by the
 * browser's dismissed keys. A changed notice has a new key, so it shows
 * again.
 */
export function useHomeNotices(orgSlug: string, workspaces: Workspace[]) {
  const { data } = useQuery(pendingWorkspaceUpgradesOptions(orgSlug))
  // The same read as Workspace settings, so the two show the same files.
  const details = useQueries({
    queries: workspaces.map((workspace) =>
      workspaceDetailOptions(orgSlug, workspace.slug),
    ),
  })
  // A skipped file counts only when the current tree of the default branch
  // holds it, so this reads that tree for each Workspace with skipped files.
  const trees = useQueries({
    queries: workspaces.map((workspace, index) => {
      const detail = details[index]?.data
      return {
        ...workspaceGitTreeOptions(
          orgSlug,
          workspace.slug,
          workspaceTreeSha(detail ?? workspace),
        ),
        enabled: (detail?.skippedFiles?.length ?? 0) > 0,
      }
    }),
  })
  const [preferences, updatePreferences] = useUserPreferences()
  const problems: HomeNotice[] = workspaces.flatMap((workspace, index) => {
    const { files: skippedFiles, fixable } = skippedFilesInTree(
      details[index]?.data?.skippedFiles ?? [],
      trees[index]?.data?.paths,
    )
    if (skippedFiles.length === 0) return []
    return [
      {
        kind: "problem",
        workspace,
        skippedFiles,
        fixable,
        dismissKey: [
          orgSlug,
          workspace.slug,
          "hydrate-skipped",
          ...skippedFiles.map((file) => `${file.path}:${file.reason}`),
        ].join("/"),
      },
    ]
  })
  const upgrades: HomeNotice[] = workspaces.flatMap((workspace) =>
    (data?.find((entry) => entry.workspaceSlug === workspace.slug)?.items ?? [])
      .filter(upgradeCanStart)
      .map((item) => ({
        kind: "upgrade",
        workspace,
        item,
        dismissKey: upgradeDismissKey({
          orgSlug,
          workspaceSlug: workspace.slug,
          key: item.key,
          status: item.status,
        }),
      })),
  )
  const all = [...problems, ...upgrades]
  const dismissed = all.filter((entry) =>
    preferences.dismissedUpgrades.includes(entry.dismissKey),
  )
  return {
    shown: all.filter((entry) => !dismissed.includes(entry)),
    dismissed,
    updatePreferences,
  }
}
