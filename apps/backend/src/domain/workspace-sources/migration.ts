import type { Env } from "../../config/env.js"
import {
  listOrgLinkedRepositories,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import { workspaceRelativePath } from "../../services/git/root-folder.js"
import {
  getFileContent,
  listFilesInTree,
} from "../../services/github/installation-write-client.js"
import { isLinkedRepositoryDeclaration } from "../workspaces/layout.js"
import {
  planSourceMigration,
  SOURCE_MIGRATION_HOOKS,
  type SourceMigrationHook,
  type SourceMigrationReport,
} from "./migration-plan.js"
import { workspaceGithubRepository } from "./repository.js"
import { SOURCES_FILE_PATH, type SourceProvider } from "./sources-file.js"

/**
 * Plan the migration of the connections of one org to Workspace sources
 * (ADR-050), and report it. It writes nothing: upgrade step 1 writes the
 * sources in the upgrade pull request (ADR-053). Call it inside the org
 * context (`withOrgIdContext`).
 */
export async function planOrgSourceMigration(input: {
  orgId: string
  env: Env
  hooks?: Partial<Record<SourceProvider, SourceMigrationHook>>
}): Promise<SourceMigrationReport> {
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
      if (!repository) return { ...workspace, sourcesFile: null }
      // Paths relative to the Workspace root folder, as the files below use.
      const declarations = (await listFilesInTree(repository)).flatMap(
        (file) => {
          const path = workspaceRelativePath(repository.rootPath, file.path)
          return path !== null && isLinkedRepositoryDeclaration(path)
            ? [{ ...file, path }]
            : []
        },
      )
      return {
        ...workspace,
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
  return planSourceMigration({
    workspaces,
    linked: await listOrgLinkedRepositories(input.orgId),
    bindings,
  }).report
}
