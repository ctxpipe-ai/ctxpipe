import type { Env } from "../../config/env.js"
import {
  listOrgLinkedRepositories,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import {
  type CommitFile,
  createPullRequestWithFiles,
  getFileContent,
  getFileContentBytes,
  listFilesInTree,
  listOpenPullRequestsByBranchPrefix,
} from "../../services/github/installation-write-client.js"
import { isLinkedRepositoryDeclaration } from "../workspaces/layout.js"
import { applySourceFileChange } from "./edit.js"
import {
  planSourceMigration,
  SOURCE_MIGRATION_HOOKS,
  type SourceMigrationHook,
  type SourceMigrationReport,
} from "./migration-plan.js"
import { workspaceGithubRepository } from "./repository.js"
import { SOURCES_FILE_PATH, type SourceProvider } from "./sources-file.js"

const MIGRATION_BRANCH_PREFIX = "ctxpipe/sources/migrate"

/**
 * The commit change that moves each file under a `from` directory to the
 * same path under its `to` directory, with the same bytes. Git sees each
 * move as a rename.
 */
export async function movedFiles(input: {
  moves: ReadonlyArray<{ from: string; to: string }>
  paths: readonly string[]
  read: (path: string) => Promise<Buffer>
}): Promise<{ files: CommitFile[]; deletePaths: string[] }> {
  const files: CommitFile[] = []
  const deletePaths: string[] = []
  for (const path of input.paths) {
    const move = input.moves.find(({ from }) => path.startsWith(from))
    if (!move) continue
    files.push({
      path: `${move.to}${path.slice(move.from.length)}`,
      content: (await input.read(path)).toString("base64"),
      encoding: "base64",
    })
    deletePaths.push(path)
  }
  return { files, deletePaths }
}

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
  const disableLegacy = async (workspaceId: string) => {
    for (const moved of plan.report.moved)
      if (moved.workspaceId === workspaceId)
        await hooks
          .find((hook) => hook.provider === moved.provider)
          ?.disableLegacy?.({
            orgId: input.orgId,
            connectionId: moved.connectionId,
          })
  }
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
        return { ...workspace, repository, sourcesFile: null, paths: [] }
      const tree = await listFilesInTree(repository)
      const declarations = tree.filter((file) =>
        isLinkedRepositoryDeclaration(file.path),
      )
      return {
        ...workspace,
        repository,
        paths: tree.map((file) => file.path),
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
        text = applySourceFileChange(text, change).text
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
        await disableLegacy(workspaceId)
        continue
      }
      const { repository } = workspace
      const moved = await movedFiles({
        moves: plan.moves.get(workspaceId) ?? [],
        paths: workspace.paths,
        read: async (path) => {
          const file = await getFileContentBytes({ ...repository, path })
          if (file.kind !== "bytes") throw new Error(`Cannot read ${path}`)
          return file.bytes
        },
      })
      const pull = await createPullRequestWithFiles({
        ...workspace.repository,
        baseBranch: workspace.repository.branch,
        featureBranchPrefix: MIGRATION_BRANCH_PREFIX,
        title: "Move connector sources into .ctxpipe/sources.yaml",
        body: `ctx| now reads the sources of this Workspace from \`${SOURCES_FILE_PATH}\`. This PR adds ${changes.length} source(s) from the existing connector settings, deletes the repository files that a GitHub source replaces, and moves old Slack captures to the managed paths of their source. Other old mirrored content stays where it is.`,
        commitMessage: "Move connector sources into .ctxpipe/sources.yaml",
        files: [{ path: SOURCES_FILE_PATH, content: text }, ...moved.files],
        deletePaths: [
          ...(plan.deletePaths.get(workspaceId) ?? []),
          ...moved.deletePaths,
        ],
      })
      pullRequests.push({
        workspaceId,
        pullRequestUrl: pull.pullUrl,
        existing: false,
      })
      await disableLegacy(workspaceId)
    } catch (error) {
      failures.push({
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ...plan.report, pullRequests, failures }
}
