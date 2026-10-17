import { isConnectorMirrorPath } from "../codeIngestion/connectorMirrorPaths.js"
import { assignImportedRepository } from "./dest-workspace-first.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import {
  type ExportClaimRow,
  type ExportObjectRow,
  objectPathFromPayload,
  planKnowledgeProjection,
  repositoryIdFromDedup,
} from "./migration-export.js"
import { INGESTION_V2_PUBLISH_FORMAT } from "./workspace-format.js"

/**
 * True when hydrate adds the main-era knowledge to the projection. Below
 * format 3 no ingestion runs, so the knowledge of the Workspace stays as
 * main kept it in Postgres until the operator merges the format upgrade.
 * An invalid format file (-1) gets no overlay.
 */
export function legacyKnowledgeOverlayApplies(format: number): boolean {
  return format >= 0 && format < INGESTION_V2_PUBLISH_FORMAT
}

/**
 * The main-era objects that this Workspace gets, as Markdown files that are
 * not in git. Hydrate adds them to the git files before it makes units, so
 * that every read tool serves them. It writes nothing to git.
 *
 * Git stays authoritative:
 * - A planned file at a path that git has is dropped.
 * - An object whose payload path is a Markdown file in the tree gets no
 *   file: hydrate makes it from git. A link to it goes to that file.
 *
 * The rendering is the one of upgrade step 1, with no model call. The
 * objects are sorted by id, so the same rows give the same files.
 */
export async function legacyKnowledgeOverlay(input: {
  workspaceId: string
  workspaceRepositoryUrl: string
  /** The paths of the git tree that hydrate reads. */
  treePaths: ReadonlySet<string>
  /** The Markdown files of the git tree. */
  files: ReadonlyArray<{ path: string; content: string }>
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
  const write = new Set<string>()
  for (const object of objects) {
    const assignment = assignImportedRepository({
      repositoryId: repositoryIdFromDedup(object.deduplicationKey),
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
  return knowledge.files.filter((file) => !input.treePaths.has(file.path))
}
