import type { Env } from "../../config/env.js"
import {
  listOrgLinkedRepositories,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import {
  createPullRequestWithFiles,
  getFileContent,
  listOpenPullRequestsByBranchPrefix,
} from "../../services/github/installation-write-client.js"
import { applySourceFileChange, type SourceChange } from "./edit.js"
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
 * After the migration PR of a Workspace exists, turn off the legacy sync of
 * each connection that moved into it, so that two mirrors do not write the
 * same repository.
 */
export async function disableMovedLegacySyncs(input: {
  orgId: string
  hooks: readonly SourceMigrationHook[]
  changes: readonly SourceChange[]
}): Promise<void> {
  for (const change of input.changes) {
    if (change.action === "remove") continue
    const hook = input.hooks.find((item) => item.provider === change.provider)
    await hook?.disableLegacy?.({
      orgId: input.orgId,
      connectionId: change.connectionId,
    })
  }
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
  const disableMovedLegacy = (changes: readonly SourceChange[]) =>
    disableMovedLegacySyncs({ orgId: input.orgId, hooks, changes })
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
      return {
        ...workspace,
        repository,
        sourcesFile: repository
          ? ((await getFileContent({
              ...repository,
              path: SOURCES_FILE_PATH,
            })) ?? null)
          : null,
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
        await disableMovedLegacy(changes)
        continue
      }
      const pull = await createPullRequestWithFiles({
        ...workspace.repository,
        baseBranch: workspace.repository.branch,
        featureBranchPrefix: MIGRATION_BRANCH_PREFIX,
        title: "Move connector sources into .ctxpipe/sources.yaml",
        body: `ctx| now reads the sources of this Workspace from \`${SOURCES_FILE_PATH}\`. This PR adds ${changes.length} source(s) from the existing connector settings. Old mirrored content stays where it is.`,
        commitMessage: "Move connector sources into .ctxpipe/sources.yaml",
        files: [{ path: SOURCES_FILE_PATH, content: text }],
      })
      pullRequests.push({
        workspaceId,
        pullRequestUrl: pull.pullUrl,
        existing: false,
      })
      await disableMovedLegacy(changes)
    } catch (error) {
      failures.push({
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ...plan.report, pullRequests, failures }
}
