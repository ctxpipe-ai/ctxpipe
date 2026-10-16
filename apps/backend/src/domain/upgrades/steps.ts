import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { ownershipMigrationFiles } from "../ingestion/ownership-migration.js"
import { planSourcesConversion } from "../workspace-sources/convert-to-files.js"
import { githubSourcePathsByRepository } from "../workspace-sources/github-sources.js"
import { SOURCES_FOLDER_PREFIX } from "../workspace-sources/source-tree.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
import { importKeyCleanupFiles } from "../workspaces/hydrate-write-jobs.js"
import type { GitUpgradeStep } from "./registry.js"

type UpgradeTree = Parameters<GitUpgradeStep["plan"]>[0]
type UpgradeContext = Parameters<GitUpgradeStep["plan"]>[1]

/** Every blob under `sources/` of the tree, with its text. */
function readSourceFiles(tree: UpgradeTree) {
  return Promise.all(
    tree
      .paths()
      .filter((path) => path.startsWith(SOURCES_FOLDER_PREFIX))
      .map(async (path) => ({ path, text: (await tree.read(path)) ?? "" })),
  )
}

/** The Workspace repository URL, from the database. */
async function workspaceRepositoryUrl(ctx: UpgradeContext): Promise<string> {
  const [workspace] = await withOrgDbContext(ctx.orgId, (db) =>
    db
      .select({ url: workspaces.workspaceRepositoryUrl })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)),
  )
  if (!workspace) throw new Error("The Workspace does not exist")
  return workspace.url
}

/**
 * Upgrade step 2 (ADR-053 section 4; ADR-050 decision 14): one Markdown file
 * for each source under `sources/`, in place of `.ctxpipe/sources.yaml`.
 */
export const sourcesConversionStep: GitUpgradeStep = {
  format: 2,
  title: "One file for each source under sources/",
  async plan(tree, ctx) {
    return planSourcesConversion({
      sourcesYaml: await tree.read(SOURCES_FILE_PATH),
      sourceFiles: await readSourceFiles(tree),
      // A GitHub entry that names the Workspace repository is skipped.
      workspaceUrl: await workspaceRepositoryUrl(ctx),
    })
  },
}

/**
 * Upgrade step 3 (ADR-053 section 4; ADR-052 section 3): give each file that
 * the old pipeline extracted to ingestion v2 (`generated_by:
 * ctxpipe-extract` and its repository in `sources`). It reads the Workspace
 * repository URL from the database.
 *
 * It also removes the `import_key` of each knowledge file. Step 1 writes the
 * key so that a second plan of step 1 finds its own export. After this last
 * step nothing needs the key, so hydrate has no key to remove after the
 * merge.
 */
export const ownershipMigrationStep: GitUpgradeStep = {
  format: 3,
  title: "Ingestion v2 ownership of extracted files",
  async plan(tree, ctx) {
    const url = await workspaceRepositoryUrl(ctx)
    const files = await Promise.all(
      tree
        .paths()
        .filter((path) => path.startsWith("knowledge/") && path.endsWith(".md"))
        .map(async (path) => ({
          path,
          content: (await tree.read(path)) ?? "",
        })),
    )
    const sourceFiles = await readSourceFiles(tree)
    const report: string[] = []
    const owned = ownershipMigrationFiles({
      workspaceRepositoryUrl: url,
      // The projection decides which source file owns a repository.
      sourcePaths: githubSourcePathsByRepository(
        sourceFiles,
        await listWorkspaceSourceRows({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        }),
      ),
      files,
      onDroppedClaim: ({ path, index, reason }) =>
        report.push(`${path}: claim ${index + 1} is removed. ${reason}.`),
    })
    const content = new Map(files.map((file) => [file.path, file.content]))
    for (const file of owned) content.set(file.path, file.content)
    const writes = new Map(owned.map((file) => [file.path, file]))
    const unkeyed = importKeyCleanupFiles(
      [...content].map(([path, text]) => ({ path, content: text })),
    )
    for (const file of unkeyed) writes.set(file.path, file)
    if (unkeyed.length)
      report.push(
        `Removed the import key of ${unkeyed.length} knowledge file(s). ctx| does not need it after the upgrade.`,
      )
    return { writes: [...writes.values()], deletes: [], report }
  },
}
