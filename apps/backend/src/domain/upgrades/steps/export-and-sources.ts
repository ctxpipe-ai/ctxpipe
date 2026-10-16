import { parseEnv } from "../../../config/env.js"
import { loadKnowledgeProjectionSource } from "../../../models/workspace-export.js"
import { listOrgLinkedRepositories } from "../../../models/workspaces.js"
import { isConnectorMirrorPath } from "../../codeIngestion/connectorMirrorPaths.js"
import { SourceChangeError } from "../../workspace-sources/edit.js"
import {
  planSourceMigration,
  SOURCE_MIGRATION_HOOKS,
  type SourceMigrationHook,
} from "../../workspace-sources/migration-plan.js"
import {
  SOURCES_FILE_PATH,
  type SourceProvider,
} from "../../workspace-sources/sources-file.js"
import { applySourcesYamlChange } from "../../workspace-sources/sources-yaml-edit.js"
import { assignImportedRepository } from "../../workspaces/dest-workspace-first.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
} from "../../workspaces/layout.js"
import { linkedRepositoryUrlSchema } from "../../workspaces/linked-repository-url.js"
import {
  type ExportObjectRow,
  migrationLinkedRepositoryUrls,
  planKnowledgeProjection,
  repositoryIdFromDedup,
  upgradeLinkedRepositories,
} from "../../workspaces/migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "../../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../workspaces/write-status.js"
import type {
  GitUpgradeStep,
  UpgradeStepPlan,
  UpgradeTreeReader,
} from "../registry.js"

/**
 * Where an old Postgres knowledge object (main's `objects` table) came from.
 * Main wrote these rows only from its code ingestion of git repositories:
 * the org repositories and the connector sync repository with its mirror
 * files. People and MCP clients could not write knowledge on main.
 *
 * - `kept`: an org repository that is not on GitHub. Sources link only
 *   GitHub repositories, and fresh ingestion reads only GitHub sources, so
 *   nothing makes this knowledge again. Step 1 exports it.
 * - `github`: an org repository on GitHub. Step 1 links it as a source, and
 *   the re-ingestion upgrade makes its knowledge again (ADR-053 section 5).
 * - `workspace`: the repository of a Workspace (for example the old
 *   connector sync repository). Hydrate reads its files directly: the
 *   connector mirror files and the knowledge files.
 * - `no_repository`: no org repository. These are connector nodes (Linear
 *   issues and teams, Slack threads, pull requests) that main made from the
 *   mirror files, which hydrate makes again from the same files, and rows of
 *   a repository that was deleted.
 */
export type LegacyKnowledgeOrigin =
  | { kind: "kept"; repositoryUrl: string }
  | { kind: "github" }
  | { kind: "workspace" }
  | { kind: "no_repository" }

export function legacyKnowledgeOrigin(input: {
  object: Pick<ExportObjectRow, "deduplicationKey">
  workspaceByRepositoryId: ReadonlyMap<string, string>
  repositoryGitUrlById: ReadonlyMap<string, string>
}): LegacyKnowledgeOrigin {
  const repositoryId = repositoryIdFromDedup(input.object.deduplicationKey)
  if (!repositoryId) return { kind: "no_repository" }
  if (input.workspaceByRepositoryId.has(repositoryId))
    return { kind: "workspace" }
  const gitUrl = input.repositoryGitUrlById.get(repositoryId)
  if (!gitUrl) return { kind: "no_repository" }
  return githubRepoFullNameFromWorkspaceUrl(gitUrl)
    ? { kind: "github" }
    : { kind: "kept", repositoryUrl: gitUrl }
}

const PROVIDER_NAMES: Record<SourceProvider, string> = {
  github: "GitHub",
  linear: "Linear",
  notion: "Notion",
  slack: "Slack",
  confluence: "Confluence",
  pagerduty: "PagerDuty",
}

/** The connection scopes: the source entries from the connection settings. */
async function connectorSources(input: {
  tree: UpgradeTreeReader
  orgId: string
  workspaceId: string
  remote: { url: string; connectionId: string | null }
  sourcesFile: string | null
  linkedUrls: readonly string[]
  /** The first Workspace reports the connections that map to no Workspace. */
  firstWorkspace: boolean
  hooks: Partial<Record<SourceProvider, SourceMigrationHook>>
}): Promise<{
  sourcesFile: string | null
  writes: UpgradeStepPlan["writes"]
  deletes: string[]
  report: string[]
}> {
  const hooks = Object.values(input.hooks)
  const env = parseEnv(process.env)
  const bindings = (
    await Promise.all(
      hooks.map((hook) => hook.listLegacyBindings({ orgId: input.orgId, env })),
    )
  ).flat()
  const linked = (await listOrgLinkedRepositories(input.orgId))
    .filter((row) => row.workspaceId === input.workspaceId)
    .map((row) => ({ workspaceId: row.workspaceId, gitUrl: row.gitUrl }))
  const plan = planSourceMigration({
    // The GitHub repositories move with `upgradeLinkedRepositories`, so the
    // plan maps only the connections here.
    workspaces: [
      {
        id: input.workspaceId,
        workspaceRepositoryUrl: input.remote.url,
        githubConnectionId: input.remote.connectionId,
        sourcesFile: input.sourcesFile,
      },
    ],
    linked: [
      ...linked,
      ...input.linkedUrls.map((gitUrl) => ({
        workspaceId: input.workspaceId,
        gitUrl,
      })),
    ],
    bindings,
  })
  const report = plan.report.unmapped
    .filter(
      (item) =>
        item.workspaceId === input.workspaceId ||
        (item.workspaceId === null && input.firstWorkspace),
    )
    .map(
      (item) =>
        `Not moved: a ${PROVIDER_NAMES[item.provider]} connection. ${item.reason}.`,
    )
  let sourcesFile = input.sourcesFile
  try {
    for (const change of plan.changes.get(input.workspaceId) ?? []) {
      sourcesFile = applySourcesYamlChange(sourcesFile, change).text
      if (change.action === "add")
        report.push(
          `Added a ${PROVIDER_NAMES[change.provider]} source from the settings of its connection.`,
        )
    }
  } catch (error) {
    if (!(error instanceof SourceChangeError)) throw error
    return {
      sourcesFile: input.sourcesFile,
      writes: [],
      deletes: [],
      report: [
        `Not moved: the connection settings. \`${SOURCES_FILE_PATH}\` is not a valid version 1 file (${error.message}). Fix the file, then start the upgrade again.`,
      ],
    }
  }
  // The old mirror files of a moved connection go to their managed paths,
  // only in the repository that the connection synced to.
  const writes: UpgradeStepPlan["writes"] = []
  const deletes: string[] = []
  const workspaceUrl = normalizeWorkspaceRepositoryUrl(input.remote.url)
  const files = input.tree.paths().map((path) => ({
    path,
    sha: input.tree.blobSha(path) ?? "",
  }))
  for (const moved of plan.report.moved) {
    const hook = input.hooks[moved.provider]
    const binding = bindings.find(
      (item) =>
        item.provider === moved.provider &&
        item.connectionId === moved.connectionId &&
        "syncRepositoryUrl" in item,
    )
    if (
      !hook?.legacyMoves ||
      !binding ||
      !("syncRepositoryUrl" in binding) ||
      normalizeWorkspaceRepositoryUrl(binding.syncRepositoryUrl) !==
        workspaceUrl
    )
      continue
    for (const move of await hook.legacyMoves({
      files,
      read: (path) => input.tree.read(path),
    })) {
      const bytes = await input.tree.readBytes(move.from)
      if (!bytes || deletes.includes(move.from)) continue
      writes.push({
        path: move.to,
        content: bytes.toString("base64"),
        encoding: "base64",
      })
      deletes.push(move.from)
    }
  }
  if (deletes.length)
    report.push(
      `Moved ${deletes.length} old connector file(s) to the paths that their sources manage. Git keeps their history.`,
    )
  return { sourcesFile, writes, deletes, report }
}

/**
 * Upgrade step 1 (ADR-053 sections 4 and 5): move the sources of a
 * main-era Workspace into `.ctxpipe/sources.yaml`, and export the old
 * Postgres knowledge that fresh ingestion cannot make again.
 *
 * - The org repositories (main's `repositories` table) of the first
 *   Workspace and the `repositories/*.md` files become GitHub sources. A
 *   file goes away when the sources file links its repository.
 * - The connection settings become source entries (the connection scopes).
 * - Knowledge files are written only for the `kept` objects of
 *   {@link legacyKnowledgeOrigin}. The report counts the other objects.
 *
 * The plan reads the tree, the database and the connection settings. It
 * writes nothing. A plan on its own output changes nothing: the import key
 * finds each exported file, and the sources file already has each entry.
 */
export function exportAndSourcesStep(
  hooks: Partial<
    Record<SourceProvider, SourceMigrationHook>
  > = SOURCE_MIGRATION_HOOKS,
): GitUpgradeStep {
  return {
    format: 1,
    title: "Move the sources and keep the old knowledge",
    async plan(tree, ctx) {
      const connectionId = ctx.remote.connectionId
      const sourcesFile = await tree.read(SOURCES_FILE_PATH)
      const repositoryFiles = await Promise.all(
        tree
          .paths()
          .filter(isLinkedRepositoryDeclaration)
          .map(async (path) => ({
            path,
            content: (await tree.read(path)) ?? "",
          })),
      )
      const existingKnowledge = await Promise.all(
        tree
          .paths()
          .filter(
            (path) =>
              path.startsWith("knowledge/") &&
              path.endsWith(".md") &&
              !isConnectorMirrorPath(path),
          )
          .map(async (path) => ({
            path,
            content: (await tree.read(path)) ?? "",
          })),
      )
      const source = await loadKnowledgeProjectionSource()
      const linkedUrls = migrationLinkedRepositoryUrls({
        workspaceId: ctx.workspaceId,
        firstWorkspaceId: source.firstWorkspaceId,
        repositories: [...source.repositoryGitUrlById].map(([id, gitUrl]) => ({
          id,
          gitUrl,
        })),
        workspaceByRepositoryId: source.workspaceByRepositoryId,
      })
      const report: string[] = []

      // 1. GitHub repositories: the org repositories and `repositories/*.md`.
      const linkedRepositories = connectionId
        ? upgradeLinkedRepositories({
            sourcesFile,
            connectionId,
            files: repositoryFiles,
            repositories: linkedUrls.map((gitUrl) => ({ gitUrl })),
          })
        : {
            sourcesFile: null,
            deletePaths: [],
            skipped: [
              ...repositoryFiles.map((file) => file.path),
              ...linkedUrls,
            ].map((item) => ({
              item,
              reason: "The Workspace has no GitHub connection",
            })),
          }
      if (linkedRepositories.sourcesFile)
        report.push(
          `Linked the GitHub repositories of this Workspace in \`${SOURCES_FILE_PATH}\`. Fresh ingestion reads them from there.`,
        )
      for (const path of linkedRepositories.deletePaths)
        report.push(`Removed \`${path}\`: its repository is now a source.`)
      for (const skipped of linkedRepositories.skipped)
        report.push(`Not linked: ${skipped.item}. ${skipped.reason}.`)

      // 2. The connection scopes.
      const connectors = await connectorSources({
        tree,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        remote: ctx.remote,
        sourcesFile: linkedRepositories.sourcesFile ?? sourcesFile,
        linkedUrls: [
          ...linkedUrls,
          ...repositoryFiles.flatMap((file) => {
            const parsed = parseLinkedRepositoryMarkdown(file.content)
            return parsed.malformed ? [] : [parsed.git]
          }),
        ],
        firstWorkspace: ctx.workspaceId === source.firstWorkspaceId,
        hooks,
      })
      report.push(...connectors.report)

      // 3. Only the knowledge that fresh ingestion cannot make again.
      const counts = { kept: 0, github: 0, workspace: 0, no_repository: 0 }
      const keptByRepository = new Map<string, number>()
      // The objects that this Workspace gets: those of its own repository,
      // and in the first Workspace those of every other org repository.
      const assigned = source.objects.filter((object) => {
        const assignment = assignImportedRepository({
          repositoryId: repositoryIdFromDedup(object.deduplicationKey),
          workspaceByRepositoryId: source.workspaceByRepositoryId,
          firstWorkspaceId: source.firstWorkspaceId,
        })
        return (
          "workspaceId" in assignment &&
          assignment.workspaceId === ctx.workspaceId
        )
      })
      const kept = assigned.filter((object) => {
        const origin = legacyKnowledgeOrigin({
          object,
          workspaceByRepositoryId: source.workspaceByRepositoryId,
          repositoryGitUrlById: source.repositoryGitUrlById,
        })
        counts[origin.kind] += 1
        if (origin.kind !== "kept") return false
        keptByRepository.set(
          origin.repositoryUrl,
          (keptByRepository.get(origin.repositoryUrl) ?? 0) + 1,
        )
        return true
      })
      const knowledge = await planKnowledgeProjection({
        workspaceId: ctx.workspaceId,
        firstWorkspaceId: source.firstWorkspaceId,
        workspaceByRepositoryId: source.workspaceByRepositoryId,
        repositoryGitUrlById: new Map(
          [...source.repositoryGitUrlById].flatMap(([id, url]) => {
            const safe = linkedRepositoryUrlSchema.safeParse(url)
            return safe.success ? [[id, safe.data] as const] : []
          }),
        ),
        objects: kept,
        claims: source.claims,
        existingKnowledge,
        workspaceRepositoryUrl: ctx.remote.url,
        stampImportKey: true,
        // A plan must not call a model: a person's file at the same path
        // stays, and the export takes a new file name.
        classifyUnkeyed: async () => "new_name",
      })
      if (knowledge.files.length)
        for (const [url, count] of [...keptByRepository].sort())
          report.push(
            `Kept ${count} knowledge item(s) from ${url} in \`knowledge/\`. Fresh ingestion reads only GitHub repositories, so it cannot make them again.`,
          )
      report.push(
        `Not exported, because ctx| makes it again: ${counts.github} item(s) from GitHub repositories (the re-ingestion upgrade), ${counts.workspace} item(s) from Workspace repositories and ${counts.no_repository} connector item(s) (hydrate reads the files of the Workspace).`,
      )

      const writes: UpgradeStepPlan["writes"] = [...knowledge.files]
      const sourcesText = connectors.sourcesFile
      if (sourcesText !== null && sourcesText !== sourcesFile)
        writes.push({ path: SOURCES_FILE_PATH, content: sourcesText })
      writes.push(...connectors.writes)
      return {
        writes,
        deletes: [...linkedRepositories.deletePaths, ...connectors.deletes],
        report,
      }
    },
  }
}
