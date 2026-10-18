import { parseEnv } from "../../../config/env.js"
import {
  loadKnowledgeProjectionSource,
  loadRepositoryWorkspaceMaps,
  type RepositoryWorkspaceMaps,
} from "../../../models/workspace-export.js"
import { listOrgLinkedRepositories } from "../../../models/workspaces.js"
import {
  PlainGitUrlError,
  resolvePlainGitRemote,
} from "../../../services/git/plain-git-remote.js"
import { isConnectorMirrorPath } from "../../codeIngestion/connectorMirrorPaths.js"
import { SourceChangeError } from "../../workspace-sources/edit.js"
import { githubSourceRepositories } from "../../workspace-sources/github-sources.js"
import {
  planSourceMigration,
  SOURCE_MIGRATION_HOOKS,
  type SourceMigrationHook,
} from "../../workspace-sources/migration-plan.js"
import { sourceRepositoryUrls } from "../../workspace-sources/providers/git.js"
import {
  gitSourcePath,
  SOURCE_FILES_FOLDER,
} from "../../workspace-sources/source-file.js"
import {
  parseSourceFile,
  renderSourceFile,
} from "../../workspace-sources/source-file-text.js"
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
  objectPathFromPayload,
  objectTitleFromPayload,
  planKnowledgeProjection,
  repositoryIdFromDedup,
  upgradeLinkedRepositories,
} from "../../workspaces/migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "../../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../workspaces/write-status.js"
import type {
  GitUpgradeStep,
  UpgradeNotice,
  UpgradeStepPlan,
  UpgradeTreeReader,
} from "../registry.js"

/**
 * Where an old Postgres knowledge object (main's `objects` table) came from.
 * Main wrote these rows only from its code ingestion of git repositories:
 * the org repositories and the connector sync repository with its mirror
 * files. People and MCP clients could not write knowledge on main.
 *
 * - `kept`: nothing makes this knowledge again, so step 1 exports it:
 *   - `not_github`: an org repository that is not on GitHub and that no
 *     plain git source links (its URL breaks the plain git URL policy of
 *     the deployment mode, see `resolvePlainGitRemote`). Fresh ingestion
 *     cannot read it.
 *   - `not_linked`: a GitHub repository that the final sources file does
 *     not link.
 *   - `workspace_repository`: an object of the repository of a Workspace
 *     that no Markdown file of the Workspace backs, whatever its key prefix.
 *     Ingestion v2 does not ingest the Workspace repository, and hydrate
 *     makes objects only from Markdown files.
 *   - `codeowners`: a team from a CODEOWNERS file (`team:github:` key).
 *     Hydrate does not make it, and it has no org repository.
 * - `github`: a repository that a GitHub source or a plain git source of
 *   the Workspace links (CTX-815). The re-ingestion upgrade makes its
 *   knowledge again (ADR-053 section 5).
 * - `workspace`: an object of the repository of a Workspace that a Markdown
 *   file of the Workspace backs. Hydrate makes it again from that file.
 * - `no_repository`: no org repository. These are connector items (Linear
 *   issues and teams, Slack threads). Hydrate makes an item again from its
 *   mirror file, and fresh ingestion of its connector source, which step 1
 *   moves into the sources file, fetches it again.
 * - `deleted_repository`: the key names a repository id (`repo_`) that the
 *   org does not have any more. No source reads that repository, so step 1
 *   does not export its knowledge.
 */
export type LegacyKnowledgeOrigin =
  | {
      kind: "kept"
      /** The repository URL, or the group name in the report. */
      from: string
      reason: keyof typeof KEPT_REASONS
    }
  | { kind: "github" }
  | { kind: "workspace" }
  | { kind: "no_repository" }
  | { kind: "deleted_repository" }

export function legacyKnowledgeOrigin(input: {
  object: Pick<ExportObjectRow, "deduplicationKey">
  /** True when a Markdown file that stays in the Workspace backs the object. */
  markdownBacked: boolean
  workspaceByRepositoryId: ReadonlyMap<string, string>
  repositoryGitUrlById: ReadonlyMap<string, string>
  /** The normalized URLs that the final GitHub and plain git sources link. */
  linkedGitUrls: ReadonlySet<string>
}): LegacyKnowledgeOrigin {
  const key = input.object.deduplicationKey?.trim() ?? ""
  if (key.startsWith("team:github:"))
    return { kind: "kept", from: "CODEOWNERS files", reason: "codeowners" }
  const repositoryId = repositoryIdFromDedup(key)
  const gitUrl = repositoryId
    ? input.repositoryGitUrlById.get(repositoryId)
    : undefined
  if (repositoryId && input.workspaceByRepositoryId.has(repositoryId))
    return input.markdownBacked
      ? { kind: "workspace" }
      : {
          kind: "kept",
          from: gitUrl ?? "the Workspace repository",
          reason: "workspace_repository",
        }
  if (!gitUrl)
    return repositoryId?.startsWith("repo_")
      ? { kind: "deleted_repository" }
      : { kind: "no_repository" }
  if (input.linkedGitUrls.has(normalizeWorkspaceRepositoryUrl(gitUrl)))
    return { kind: "github" }
  if (!githubRepoFullNameFromWorkspaceUrl(gitUrl))
    return { kind: "kept", from: gitUrl, reason: "not_github" }
  return { kind: "kept", from: gitUrl, reason: "not_linked" }
}

const KEPT_REASONS = {
  not_github:
    "Fresh ingestion reads only GitHub repositories and public HTTPS git repositories, so it cannot make them again.",
  not_linked: `\`${SOURCES_FILE_PATH}\` does not link this repository, so fresh ingestion cannot make them again.`,
  workspace_repository:
    "This is the Workspace repository and no Markdown file of the Workspace holds them. Ingestion v2 does not ingest it, and hydrate makes items only from Markdown files, so nothing makes them again.",
  codeowners:
    "These are the teams of CODEOWNERS files. Hydrate does not make them, so nothing makes them again.",
} as const

const PROVIDER_NAMES: Record<SourceProvider, string> = {
  github: "GitHub",
  linear: "Linear",
  notion: "Notion",
  slack: "Slack",
  confluence: "Confluence",
  pagerduty: "PagerDuty",
  git: "Git",
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
  moves: Map<string, string>
  report: string[]
  notices: UpgradeNotice[]
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
  const notices: UpgradeNotice[] = report.length
    ? [
        {
          kind: "action",
          text: "Some connections did not move to this Workspace. Check the Sources of the Workspace after the merge.",
        },
      ]
    : []
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
      moves: new Map(),
      report: [
        `Not moved: the connection settings. \`${SOURCES_FILE_PATH}\` is not a valid version 1 file (${error.message}). Fix the file, then start the upgrade again.`,
      ],
      notices: [
        {
          kind: "action",
          text: "The sources file of the Workspace is not valid, so ctx| did not move the connection settings. Fix the file, then start the upgrade again.",
        },
      ],
    }
  }
  // The old mirror files of a moved connection go to their managed paths,
  // only in the repository that the connection synced to.
  const writes: UpgradeStepPlan["writes"] = []
  const deletes: string[] = []
  const moves = new Map<string, string>()
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
      if (!bytes || moves.has(move.from)) continue
      // A newer file at the managed path wins: the old file stays.
      if (
        input.tree.blobSha(move.to) !== null ||
        writes.some((write) => write.path === move.to)
      ) {
        report.push(
          `Not moved: \`${move.from}\`. The tree already has \`${move.to}\`, so the old file stays. Compare the two files, then delete the old file.`,
        )
        notices.push({
          kind: "action",
          text: "Some old connector files stay next to their new files. Compare each pair, then delete the old file.",
        })
        continue
      }
      writes.push({
        path: move.to,
        content: bytes.toString("base64"),
        encoding: "base64",
        mode: input.tree.mode(move.from) ?? undefined,
      })
      deletes.push(move.from)
      moves.set(move.from, move.to)
    }
  }
  if (deletes.length)
    report.push(
      `Moved ${deletes.length} old connector file(s) to the paths that their sources manage. Git keeps their history.`,
    )
  return { sourcesFile, writes, deletes, moves, report, notices }
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
/**
 * The GitHub repositories that step 1 links in `.ctxpipe/sources.yaml`: the
 * org repositories (only in the first Workspace of the org, each under its
 * own GitHub connection) and the `repositories/*.md` files (under the
 * connection of the Workspace). The re-ingestion scan uses it too, so that a
 * Workspace below format 3 shows the repositories that the upgrade gives.
 * Call it in the org context.
 */
export async function formatOneLinkedRepositories(input: {
  workspaceId: string
  /** The GitHub connection of the Workspace. */
  connectionId: string | null
  /** The text of `.ctxpipe/sources.yaml`, or null when it is absent. */
  sourcesFile: string | null
  repositoryFiles: ReadonlyArray<{ path: string; content: string }>
  /** The maps when the caller has them. Else it reads only the maps, not the knowledge store. */
  source?: RepositoryWorkspaceMaps
}) {
  const source = input.source ?? (await loadRepositoryWorkspaceMaps())
  const linkedUrls = migrationLinkedRepositoryUrls({
    workspaceId: input.workspaceId,
    firstWorkspaceId: source.firstWorkspaceId,
    repositories: [...source.repositoryGitUrlById].map(([id, gitUrl]) => ({
      id,
      gitUrl,
    })),
    workspaceByRepositoryId: source.workspaceByRepositoryId,
  })
  const connectionByUrl = new Map<string, string | null>()
  for (const [id, gitUrl] of source.repositoryGitUrlById)
    if (!connectionByUrl.has(gitUrl))
      connectionByUrl.set(
        gitUrl,
        source.repositoryConnectionById.get(id) ?? null,
      )
  // A repository with a GitHub connection becomes a GitHub source. Each
  // other repository becomes a plain git source when its URL passes every
  // plain git rule, also the DNS rule (`resolvePlainGitRemote`), as the old
  // ingestion on main read it with no credential (CTX-815). A refused URL is
  // not linked, so step 1 keeps its knowledge and exports it.
  const viaGithub = (gitUrl: string) =>
    !!connectionByUrl.get(gitUrl) &&
    !!githubRepoFullNameFromWorkspaceUrl(gitUrl)
  const linkedRepositories = upgradeLinkedRepositories({
    sourcesFile: input.sourcesFile,
    connectionId: input.connectionId,
    files: input.repositoryFiles,
    repositories: linkedUrls.filter(viaGithub).map((gitUrl) => ({
      gitUrl,
      connectionId: connectionByUrl.get(gitUrl) ?? null,
    })),
  })
  const plainGit: Array<{ gitUrl: string; url: string }> = []
  const plainGitRefused: Array<{ gitUrl: string; reason: string }> = []
  for (const gitUrl of linkedUrls) {
    if (viaGithub(gitUrl)) continue
    try {
      const remote = await resolvePlainGitRemote(gitUrl)
      plainGit.push({ gitUrl, url: remote.url })
    } catch (error) {
      if (!(error instanceof PlainGitUrlError)) throw error
      plainGitRefused.push({ gitUrl, reason: error.message })
    }
  }
  return { linkedUrls, linkedRepositories, plainGit, plainGitRefused }
}

/**
 * The plain git source files that step 1 adds: one for each plain git
 * repository that no source file of the tree names yet. A file that already
 * names the URL (also at another path) stays, so a plan on its own output
 * changes nothing.
 */
async function plainGitSourceFiles(input: {
  tree: UpgradeTreeReader
  plainGit: ReadonlyArray<{ url: string }>
}): Promise<Array<{ path: string; url: string }>> {
  const sourcePaths = input.tree
    .paths()
    .filter((path) => path.startsWith(`${SOURCE_FILES_FOLDER}/`))
  const named = new Set<string>()
  for (const path of sourcePaths) {
    const parsed = parseSourceFile(path, (await input.tree.read(path)) ?? "")
    if (parsed.ok)
      for (const url of sourceRepositoryUrls(parsed.source)) named.add(url)
  }
  const taken = new Set(sourcePaths)
  const added: Array<{ path: string; url: string }> = []
  for (const { url } of input.plainGit) {
    const key = normalizeWorkspaceRepositoryUrl(url)
    if (named.has(key)) continue
    const path = gitSourcePath(url, taken)
    if (!path) continue
    named.add(key)
    taken.add(path)
    added.push({ path, url })
  }
  return added
}

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
      const { linkedUrls, linkedRepositories, plainGit, plainGitRefused } =
        await formatOneLinkedRepositories({
          workspaceId: ctx.workspaceId,
          connectionId,
          sourcesFile,
          repositoryFiles,
          source,
        })
      const report: string[] = []
      const notices: UpgradeNotice[] = []
      const label = (object: ExportObjectRow) =>
        `"${objectTitleFromPayload(object.payload)}" (${object.deduplicationKey ?? object.id})`

      // With no first Workspace, no Workspace gets the org repositories and
      // their knowledge. Each Workspace names them.
      if (!source.firstWorkspaceId) {
        const before = report.length
        for (const [id, gitUrl] of source.repositoryGitUrlById)
          if (!source.workspaceByRepositoryId.has(id))
            report.push(
              `Not linked: ${gitUrl}. The org has no first Workspace, so no Workspace gets this repository.`,
            )
        for (const object of source.objects)
          if (
            "skip" in
            assignImportedRepository({
              repositoryId: repositoryIdFromDedup(object.deduplicationKey),
              workspaceByRepositoryId: source.workspaceByRepositoryId,
              firstWorkspaceId: null,
            })
          )
            report.push(
              `Not exported: ${label(object)}. The org has no first Workspace, so no Workspace gets this item.`,
            )
        if (report.length > before)
          notices.push({
            kind: "risk",
            text: "The organization has no first Workspace, so some repositories and their knowledge go to no Workspace.",
          })
      }

      // 1. GitHub repositories: the org repositories under their own GitHub
      //    connection, and `repositories/*.md` under the connection of the
      //    Workspace.
      if (linkedRepositories.sourcesFile)
        report.push(
          `Linked the GitHub repositories of this Workspace in \`${SOURCES_FILE_PATH}\`. Fresh ingestion reads them from there.`,
        )
      for (const path of linkedRepositories.deletePaths)
        report.push(`Removed \`${path}\`: its repository is now a source.`)
      for (const skipped of linkedRepositories.skipped)
        report.push(`Not linked: ${skipped.item}. ${skipped.reason}.`)
      // Plain git repositories: one source file for each (CTX-815).
      const plainGitFiles = await plainGitSourceFiles({ tree, plainGit })
      for (const file of plainGitFiles)
        report.push(
          `Linked ${file.url} as a plain git source in \`${file.path}\`. Fresh ingestion reads it over ${file.url.startsWith("http://") ? "HTTP" : "HTTPS"} with no credential.`,
        )
      for (const refused of plainGitRefused)
        report.push(
          `Not linked: ${refused.gitUrl}. ctx| does not read it as a plain git source: ${refused.reason.replace(/\.$/, "")}. ctx| keeps its knowledge and exports it.`,
        )
      if (linkedRepositories.skipped.length || plainGitRefused.length)
        notices.push({
          kind: "risk",
          text: "ctx| could not link some repositories as sources. Fresh ingestion does not read them.",
        })

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
      notices.push(...connectors.notices)

      // 3. Only the knowledge that fresh ingestion cannot make again. An
      //    object is `github` only when the final sources text links its
      //    repository.
      const sourcesText = connectors.sourcesFile
      let linkedGitUrls = new Set<string>()
      try {
        linkedGitUrls = new Set(
          githubSourceRepositories(sourcesText, null).map((linked) =>
            normalizeWorkspaceRepositoryUrl(linked.gitUrl),
          ),
        )
      } catch (error) {
        if (!(error instanceof SourceChangeError)) throw error
      }
      for (const { url } of plainGit)
        linkedGitUrls.add(normalizeWorkspaceRepositoryUrl(url))
      // Hydrate makes an object again only from a Markdown file that is in
      // the tree after this step: a moved file stays, a deleted one does not.
      const treePaths = new Set(tree.paths())
      const deleted = new Set([
        ...linkedRepositories.deletePaths,
        ...connectors.deletes,
      ])
      const staysAsMarkdown = (path: string) =>
        path.toLowerCase().endsWith(".md") &&
        treePaths.has(path) &&
        (connectors.moves.has(path) || !deleted.has(path))
      const counts = {
        kept: 0,
        github: 0,
        workspace: 0,
        no_repository: 0,
        deleted_repository: 0,
      }
      const keptByRepository = new Map<
        string,
        { count: number; reason: string }
      >()
      const origins = new Map<string, LegacyKnowledgeOrigin>()
      // The objects that this Workspace gets: those of its own repository,
      // and in the first Workspace those of every other org repository.
      const kept = new Set<string>()
      for (const object of source.objects) {
        const assignment = assignImportedRepository({
          repositoryId: repositoryIdFromDedup(object.deduplicationKey),
          workspaceByRepositoryId: source.workspaceByRepositoryId,
          firstWorkspaceId: source.firstWorkspaceId,
        })
        if (
          !("workspaceId" in assignment) ||
          assignment.workspaceId !== ctx.workspaceId
        )
          continue
        const path = objectPathFromPayload(object.payload)
          ?.replace(/^\.?\/+/, "")
          .trim()
        const origin = legacyKnowledgeOrigin({
          object,
          markdownBacked: !!path && staysAsMarkdown(path),
          workspaceByRepositoryId: source.workspaceByRepositoryId,
          repositoryGitUrlById: source.repositoryGitUrlById,
          linkedGitUrls,
        })
        origins.set(object.id, origin)
        counts[origin.kind] += 1
        if (origin.kind !== "kept") continue
        kept.add(object.id)
        const current = keptByRepository.get(origin.from)
        keptByRepository.set(origin.from, {
          count: (current?.count ?? 0) + 1,
          reason: KEPT_REASONS[origin.reason],
        })
      }
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
        objects: source.objects,
        writeObjectIds: kept,
        // An item that hydrate makes again keeps its links through its file,
        // at the path that step 1 moves the file to.
        resolveUnwritten: (object) => {
          const kind = origins.get(object.id)?.kind
          if (kind !== "no_repository" && kind !== "workspace") return null
          const path = objectPathFromPayload(object.payload)
            ?.replace(/^\.?\/+/, "")
            .trim()
          if (!path) return null
          if (
            kind === "workspace" ? !staysAsMarkdown(path) : !treePaths.has(path)
          )
            return null
          return connectors.moves.get(path) ?? path
        },
        claims: source.claims,
        existingKnowledge,
        workspaceRepositoryUrl: ctx.remote.url,
        stampImportKey: true,
        // A plan must not call a model: a person's file at the same path
        // stays, and the export takes a new file name.
        classifyUnkeyed: async () => "new_name",
      })
      if (knowledge.files.length && keptByRepository.size) {
        for (const [url, { count, reason }] of [...keptByRepository].sort())
          report.push(
            `Kept ${count} knowledge item(s) from ${url} in \`knowledge/\`. ${reason}`,
          )
        notices.push({
          kind: "risk",
          text: "ctx| kept some knowledge as files, because fresh ingestion cannot make it again. Do not delete these files.",
        })
      }
      for (const link of knowledge.droppedLinks)
        report.push(
          `Dropped a link: ${label(link.from)} ${link.predicate} ${link.to ? label(link.to) : "an item that this Workspace does not get"}. After the upgrade, no file of this Workspace holds the target.`,
        )
      if (knowledge.droppedLinks.length)
        notices.push({
          kind: "risk",
          text: "ctx| removed some links between knowledge items, because this Workspace does not get their target.",
        })
      report.push(
        `Not exported, because ctx| makes it again: ${counts.github} item(s) from source repositories (the re-ingestion upgrade), ${counts.workspace} item(s) from Workspace repositories and ${counts.no_repository} connector item(s) (hydrate makes Workspace items again from their Markdown files, and fresh ingestion of the connector sources fetches connector items again).`,
      )

      if (counts.deleted_repository) {
        report.push(
          `Not exported: ${counts.deleted_repository} item(s) from a deleted repository. The org does not have the repository any more, so no source reads it.`,
        )
        notices.push({
          kind: "risk",
          text: "Knowledge from a deleted repository is not exported.",
        })
      }

      const writes: UpgradeStepPlan["writes"] = [...knowledge.files]
      if (sourcesText !== null && sourcesText !== sourcesFile)
        writes.push({ path: SOURCES_FILE_PATH, content: sourcesText })
      writes.push(...connectors.writes)
      for (const file of plainGitFiles)
        writes.push({
          path: file.path,
          content: renderSourceFile(
            {
              path: file.path,
              provider: "git",
              connectionId: null,
              scope: { url: file.url },
            },
            "",
          ),
        })
      return {
        writes,
        deletes: [...linkedRepositories.deletePaths, ...connectors.deletes],
        report,
        notices,
      }
    },
  }
}
