import type { Env } from "../../config/env.js"
import {
  listOrgLinkedRepositories,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import { workspaceRelativePath } from "../../services/git/root-folder.js"
import {
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
  listOpenPullRequestsByBranchPrefix,
} from "../../services/github/installation-write-client.js"
import { isLinkedRepositoryDeclaration } from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  planSourceMigration,
  SOURCE_MIGRATION_HOOKS,
  type SourceMigrationHook,
  type SourceMigrationReport,
} from "./migration-plan.js"
import { workspaceGithubRepository } from "./repository.js"
import { SOURCES_FILE_PATH, type SourceProvider } from "./sources-file.js"
import { applySourcesYamlChange } from "./sources-yaml-edit.js"

const MIGRATION_BRANCH_PREFIX = "ctxpipe/sources/migrate"

/**
 * Migrate the connections of one org to Workspace sources (ADR-050): one PR
 * for each Workspace repository, and a report. Without `apply`, it only
 * plans. Run it from the explicit command, never at boot. Call it inside the
 * org context (`withOrgIdContext`).
 */
export async function runSourceMigration(input: {
  orgId: string
  env: Env
  apply: boolean
  hooks?: Partial<Record<SourceProvider, SourceMigrationHook>>
}): Promise<
  SourceMigrationReport & {
    pullRequests: Array<{
      workspaceId: string
      pullRequestUrl: string
      /** True when an open migration PR existed, so none was opened. */
      existing: boolean
    }>
    failures: Array<{ workspaceId: string; error: string }>
  }
> {
  const hooks = Object.values(input.hooks ?? SOURCE_MIGRATION_HOOKS)
  const bindings = (
    await Promise.all(
      hooks.map((hook) =>
        hook.listLegacyBindings({ orgId: input.orgId, env: input.env }),
      ),
    )
  ).flat()
  const workspaces = await Promise.all(
    (await listOrgWorkspaces(input.orgId)).map(async (workspace) => {
      const repository = workspaceGithubRepository(
        { ...workspace, orgId: input.orgId },
        input.env,
      )
      if (!repository)
        return { ...workspace, repository, sourcesFile: null, tree: [] }
      // Paths relative to the Workspace root folder, as the files below use.
      const tree = (await listFilesInTree(repository)).flatMap((file) => {
        const path = workspaceRelativePath(repository.rootPath, file.path)
        return path === null ? [] : [{ ...file, path }]
      })
      const declarations = tree.filter((file) =>
        isLinkedRepositoryDeclaration(file.path),
      )
      return {
        ...workspace,
        repository,
        tree,
        sourcesFile:
          (await getFileContent({ ...repository, path: SOURCES_FILE_PATH })) ??
          null,
        repositoryFiles: await Promise.all(
          declarations.map(async (file) => ({
            path: file.path,
            content:
              (await getFileContent({ ...repository, path: file.path })) ?? "",
          })),
        ),
      }
    }),
  )
  const plan = planSourceMigration({
    workspaces,
    linked: await listOrgLinkedRepositories(input.orgId),
    bindings,
  })
  // Old content moves one time for each repository, in the PR of the first
  // Workspace on it.
  const movedRepositories = new Set<string>()
  const legacyMovesFor = async (workspace: (typeof workspaces)[number]) => {
    const target = normalizeWorkspaceRepositoryUrl(
      workspace.workspaceRepositoryUrl,
    )
    const repository = workspace.repository
    if (!repository || movedRepositories.has(target)) return []
    const moves: Array<{ from: string; to: string; sha: string }> = []
    for (const moved of plan.report.moved) {
      if (moved.workspaceId !== workspace.id) continue
      const hook = hooks.find((item) => item.provider === moved.provider)
      const binding = bindings.find(
        (item) =>
          item.connectionId === moved.connectionId &&
          item.provider === moved.provider &&
          "syncRepositoryUrl" in item,
      )
      if (
        !hook?.legacyMoves ||
        !binding ||
        !("syncRepositoryUrl" in binding) ||
        normalizeWorkspaceRepositoryUrl(binding.syncRepositoryUrl) !== target
      )
        continue
      moves.push(
        ...(await hook.legacyMoves({
          files: workspace.tree,
          read: (path) => getFileContent({ ...repository, path }),
        })),
      )
    }
    movedRepositories.add(target)
    return moves
  }
  const pullRequests: Array<{
    workspaceId: string
    pullRequestUrl: string
    existing: boolean
  }> = []
  const failures: Array<{ workspaceId: string; error: string }> = []
  for (const [workspaceId, changes] of plan.changes) {
    const workspace = workspaces.find((item) => item.id === workspaceId)
    try {
      if (!workspace?.repository)
        throw new Error("The Workspace has no connected GitHub repository")
      let text = workspace.sourcesFile
      for (const change of changes)
        text = applySourcesYamlChange(text, change).text
      if (!input.apply || text === null) continue
      const [open] = await listOpenPullRequestsByBranchPrefix({
        ...workspace.repository,
        branchPrefix: MIGRATION_BRANCH_PREFIX,
      })
      if (open) {
        pullRequests.push({
          workspaceId,
          pullRequestUrl: open.pullUrl,
          existing: true,
        })
        continue
      }
      const moves = await legacyMovesFor(workspace)
      // `branch` is the default branch. For createPullRequestWithFiles,
      // `branch` is the head of the pull request, so do not pass it.
      const { branch: baseBranch, ...target } = workspace.repository
      const pull = await createPullRequestWithFiles({
        ...target,
        baseBranch,
        featureBranchPrefix: MIGRATION_BRANCH_PREFIX,
        title: "Move connector sources into .ctxpipe/sources.yaml",
        body: `ctx| now reads the sources of this Workspace from \`${SOURCES_FILE_PATH}\`. This PR adds ${changes.length} source(s) from the existing connector settings, and deletes the repository files that a GitHub source replaces. Old mirrored content stays where it is, except files that a connector moves into its new managed path (git keeps their history).`,
        commitMessage: "Move connector sources into .ctxpipe/sources.yaml",
        files: [
          { path: SOURCES_FILE_PATH, content: text },
          ...moves.map((move) => ({
            path: move.to,
            content: "",
            sha: move.sha,
          })),
        ],
        deletePaths: [
          ...(plan.deletePaths.get(workspaceId) ?? []),
          ...moves.map((move) => move.from),
        ],
      })
      pullRequests.push({
        workspaceId,
        pullRequestUrl: pull.pullUrl,
        existing: false,
      })
      // The legacy sync stays on until the PR merges and the source
      // projects (handOverLegacyBindings), so no content is lost meanwhile.
    } catch (error) {
      failures.push({
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ...plan.report, pullRequests, failures }
}
