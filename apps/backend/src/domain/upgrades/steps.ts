import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { ownershipMigrationFiles } from "../ingestion/ownership-migration.js"
import { planSourcesConversion } from "../workspace-sources/convert-to-files.js"
import { repositorySourcePathsAtRevision } from "../workspace-sources/github-sources.js"
import { SOURCES_FOLDER_PREFIX } from "../workspace-sources/source-tree.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
import { bootstrapWorkspaceFiles } from "../workspaces/bootstrap.js"
import { removeFolderMapMarkers } from "../workspaces/folder-list.js"
import { hydrateKnowledgeTree } from "../workspaces/hydrate.js"
import {
  claimsUpgradeFiles,
  importKeyCleanupFiles,
  validFromPersistFiles,
  validFromPersistRemainder,
} from "../workspaces/hydrate-write-jobs.js"
import type { GitUpgradeStep, UpgradeNotice } from "./registry.js"

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

/** The Workspace repository URL and the display name, from the database. */
async function workspaceRow(
  ctx: UpgradeContext,
): Promise<{ url: string; displayName: string }> {
  const [workspace] = await withOrgDbContext(ctx.orgId, (db) =>
    db
      .select({
        url: workspaces.workspaceRepositoryUrl,
        displayName: workspaces.displayName,
      })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)),
  )
  if (!workspace) throw new Error("The Workspace does not exist")
  return workspace
}

/**
 * Upgrade step 2 (ADR-053 section 4; ADR-050 decision 14): one Markdown file
 * for each source under `sources/`, in place of `.ctxpipe/sources.yaml`.
 */
export const sourcesConversionStep: GitUpgradeStep = {
  format: 2,
  title: "One file for each source under sources/",
  description:
    "Replaces .ctxpipe/sources.yaml with one file for each source under sources/.",
  async plan(tree, ctx) {
    return planSourcesConversion({
      sourcesYaml: await tree.read(SOURCES_FILE_PATH),
      sourceFiles: await readSourceFiles(tree),
      // A GitHub entry that names the Workspace repository is skipped.
      workspaceUrl: (await workspaceRow(ctx)).url,
    })
  },
}

/**
 * Upgrade step 3 (ADR-053 section 4; ADR-052 section 3): give each file that
 * the old pipeline extracted to ingestion v2 (`generated_by:
 * ctxpipe-extract` and its repository in `sources`). It reads the Workspace
 * repository URL from the database.
 *
 * Below format 3 hydrate commits nothing to the default branch (ADR-053
 * section 7). So this last step also makes each change that hydrate makes on
 * a format 3 tree, and hydrate has no write after the merge:
 *
 * - It removes the `import_key` of each knowledge file. Step 1 writes the
 *   key so that a second plan of step 1 finds its own export.
 * - It adds a claim for each link that has none, and a `valid_from` for each
 *   claim that has none: the time of the commit that added the file.
 * - It writes the bootstrap files: AGENTS.md with its folder section and no
 *   old folder-map markers, and the knowledge skill.
 */
export const ownershipMigrationStep: GitUpgradeStep = {
  format: 3,
  title: "Ingestion v2 ownership of extracted files",
  description:
    "Gives the extracted files under knowledge/ to the new ingestion, and updates AGENTS.md and the knowledge skill.",
  async plan(tree, ctx) {
    const workspace = await workspaceRow(ctx)
    const markdown = await Promise.all(
      tree
        .paths()
        .filter((path) => path.endsWith(".md"))
        .map(async (path) => ({
          path,
          content: (await tree.read(path)) ?? "",
        })),
    )
    const sourceFiles = await readSourceFiles(tree)
    const report: string[] = []
    const notices: UpgradeNotice[] = []
    const content = new Map(markdown.map((file) => [file.path, file.content]))
    const writes = new Map<string, { path: string; content: string }>()
    const apply = (files: ReadonlyArray<{ path: string; content: string }>) => {
      for (const file of files) {
        content.set(file.path, file.content)
        writes.set(file.path, file)
      }
      return files.length
    }
    const current = () =>
      [...content].map(([path, text]) => ({ path, content: text }))
    apply(
      ownershipMigrationFiles({
        workspaceRepositoryUrl: workspace.url,
        // The projection decides which source file owns a repository.
        sourcePaths: repositorySourcePathsAtRevision(
          sourceFiles,
          await listWorkspaceSourceRows({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
          }),
        ),
        files: current().filter((file) => file.path.startsWith("knowledge/")),
        onDroppedClaim: ({ path, index, reason }) => {
          report.push(`${path}: claim ${index + 1} is removed. ${reason}.`)
          notices.push({
            kind: "risk",
            text: "ctx| removed some claims that ingestion v2 cannot keep.",
          })
        },
        onRemovedKeys: ({ path, keys }) =>
          report.push(
            `${path}: removed the front matter keys ${keys.map((key) => `\`${key}\``).join(", ")}. Ingestion v2 does not accept these keys or their values.`,
          ),
      }),
    )
    const unkeyed = apply(importKeyCleanupFiles(current()))
    if (unkeyed)
      report.push(
        `Removed the import key of ${unkeyed} knowledge file(s). ctx| does not need it after the upgrade.`,
      )
    const units = () =>
      hydrateKnowledgeTree({ workspaceId: ctx.workspaceId, files: current() })
        .units
    const linked = apply(
      claimsUpgradeFiles({ files: current(), units: units() }),
    )
    if (linked)
      report.push(`Added a claim for each link of ${linked} knowledge file(s).`)
    const needValidFrom = units().filter(
      (unit) => validFromPersistRemainder([unit]) > 0,
    )
    const introduced = needValidFrom.length
      ? ((await ctx.introducedAt?.()) ?? new Map<string, string>())
      : new Map<string, string>()
    const dated = apply(
      needValidFrom.flatMap((unit) => {
        const timestamp = introduced.get(unit.path)
        const file = content.get(unit.path)
        return timestamp && file !== undefined
          ? validFromPersistFiles({
              files: [{ path: unit.path, content: file }],
              units: [unit],
              introducingCommitTimestamp: timestamp,
            })
          : []
      }),
    )
    if (dated)
      report.push(
        `Set the valid_from of the claims of ${dated} file(s) to the time of the commit that added the file.`,
      )
    const agentsMd = content.get("AGENTS.md")
    if (agentsMd !== undefined) {
      const unmarked = removeFolderMapMarkers(agentsMd)
      if (unmarked !== agentsMd)
        apply([{ path: "AGENTS.md", content: unmarked }])
    }
    const bootstrapped = apply(
      bootstrapWorkspaceFiles({
        displayName: workspace.displayName,
        existing: content,
      }).filter((file) => content.get(file.path) !== file.content),
    )
    if (bootstrapped)
      report.push(
        "Updated the ctx| instructions for agents: AGENTS.md and the knowledge skill.",
      )
    return { writes: [...writes.values()], deletes: [], report, notices }
  },
}
