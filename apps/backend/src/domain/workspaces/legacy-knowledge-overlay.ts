import { isConnectorMirrorPath } from "../codeIngestion/connectorMirrorPaths.js"
import { sourceRepositoryName } from "../workspace-sources/providers/git.js"
import { assignImportedRepository } from "./dest-workspace-first.js"
import type { HydrateSkip } from "./hydrate.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import {
  type ExportClaimRow,
  type ExportObjectRow,
  objectPathFromPayload,
  planKnowledgeProjection,
  repositoryIdFromDedup,
} from "./migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
import { CODE_FORMAT, INGESTION_V2_PUBLISH_FORMAT } from "./workspace-format.js"

/** Why an edit of a main-era knowledge path is refused. */
export const LEGACY_KNOWLEDGE_READ_ONLY =
  "This file is knowledge from before Workspaces. ctxpipe shows it from its database, not from git, so you cannot edit, move, or delete it. The re-ingestion of its repository replaces it after the format upgrade."

/**
 * Which main-era knowledge hydrate adds to the projection at this format.
 * - `all`: below format 3 no ingestion runs, so the knowledge of the
 *   Workspace stays as main kept it in Postgres.
 * - `sources`: at format 3 or more, upgrade step 1 did not export the
 *   knowledge of the GitHub source repositories, because the re-ingestion
 *   makes it again. Until the re-ingestion did a repository, hydrate adds
 *   the knowledge of that repository, so that it has no gap.
 * - null: an invalid format file (-1) or a format newer than the code.
 */
export function legacyKnowledgeOverlayScope(
  format: number,
): "all" | "sources" | null {
  if (format < 0 || format > CODE_FORMAT) return null
  return format < INGESTION_V2_PUBLISH_FORMAT ? "all" : "sources"
}

/**
 * Marks each skip of an overlay file. That file is not in Git, so an edit of
 * the Workspace repository cannot fix it, and the UI says so.
 */
export function markLegacyOverlaySkips(
  skipped: readonly HydrateSkip[],
  legacyPaths: ReadonlySet<string>,
): HydrateSkip[] {
  return skipped.map((skip) =>
    legacyPaths.has(skip.path)
      ? { ...skip, source: "legacy-overlay" as const }
      : skip,
  )
}

export async function legacyKnowledgeOverlay(input: {
  workspaceId: string
  workspaceRepositoryUrl: string
  /** The paths of the git tree that hydrate reads. */
  treePaths: ReadonlySet<string>
  /** The Markdown files of the git tree. */
  files: ReadonlyArray<{ path: string; content: string }>
  /** The Markdown paths that a commit of the Workspace deleted. */
  deletedPaths: ReadonlySet<string>
  /**
   * When set, only the objects of these repositories (normalized git URLs)
   * get a file. The other objects are still link targets.
   */
  onlyRepositoryUrls?: ReadonlySet<string>
  /**
   * The GitHub repositories (`owner/name`, lower case) that a re-ingestion
   * did. Their objects get no file at any format: git has their knowledge.
   */
  reingestedRepositories: ReadonlySet<string>
  source: {
    firstWorkspaceId: string | null
    workspaceByRepositoryId: ReadonlyMap<string, string>
    repositoryGitUrlById: ReadonlyMap<string, string>
    objects: readonly ExportObjectRow[]
    claims: readonly ExportClaimRow[]
  }
}): Promise<Array<{ path: string; content: string }>> {
  const { source } = input
  const objects = [...source.objects].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  const markdownPath = (object: ExportObjectRow) => {
    const path = objectPathFromPayload(object.payload)
      ?.replace(/^\.?\/+/, "")
      .trim()
    return path?.toLowerCase().endsWith(".md") && input.treePaths.has(path)
      ? path
      : null
  }
  const inScope = (repositoryId: string | null) => {
    const url = repositoryId
      ? source.repositoryGitUrlById.get(repositoryId)
      : undefined
    // `owner/name` for GitHub, `<host>/<path>` for plain git (CTX-815).
    const name = url ? sourceRepositoryName(url) : null
    if (name && input.reingestedRepositories.has(name.toLowerCase()))
      return false
    if (!input.onlyRepositoryUrls) return true
    return (
      !!url &&
      input.onlyRepositoryUrls.has(normalizeWorkspaceRepositoryUrl(url))
    )
  }
  const write = new Set<string>()
  for (const object of objects) {
    const repositoryId = repositoryIdFromDedup(object.deduplicationKey)
    if (!inScope(repositoryId)) continue
    const assignment = assignImportedRepository({
      repositoryId,
      workspaceByRepositoryId: source.workspaceByRepositoryId,
      firstWorkspaceId: source.firstWorkspaceId,
    })
    if (
      "workspaceId" in assignment &&
      assignment.workspaceId === input.workspaceId &&
      !markdownPath(object)
    )
      write.add(object.id)
  }
  if (write.size === 0) return []
  const knowledge = await planKnowledgeProjection({
    workspaceId: input.workspaceId,
    firstWorkspaceId: source.firstWorkspaceId,
    workspaceByRepositoryId: source.workspaceByRepositoryId,
    repositoryGitUrlById: new Map(
      [...source.repositoryGitUrlById].flatMap(([id, url]) => {
        const safe = linkedRepositoryUrlSchema.safeParse(url)
        return safe.success ? [[id, safe.data] as const] : []
      }),
    ),
    objects,
    claims: source.claims,
    writeObjectIds: write,
    resolveUnwritten: markdownPath,
    existingKnowledge: input.files.filter(
      (file) =>
        file.path.startsWith("knowledge/") &&
        file.path.endsWith(".md") &&
        !isConnectorMirrorPath(file.path),
    ),
    workspaceRepositoryUrl: input.workspaceRepositoryUrl,
    stampImportKey: true,
    // No model call: a file of git at the same path stays, and the object
    // takes a new file name.
    classifyUnkeyed: async () => "new_name",
  })
  return knowledge.files.filter(
    (file) =>
      !input.treePaths.has(file.path) &&
      !isConnectorMirrorPath(file.path) &&
      !input.deletedPaths.has(file.path),
  )
}
