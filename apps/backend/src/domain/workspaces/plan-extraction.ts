import type { WorkspaceExtraction } from "./extraction.js"
import { servingIdForKnowledgePath } from "./hydrate.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
} from "./layout.js"
import {
  type ExistingKnowledgeFile,
  planKnowledgeProjection,
} from "./migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Convert captured extractor references to paths already owned by the Git tree. */
export function planCapturedExtraction(input: {
  extraction: WorkspaceExtraction
  workspaceId: string
  workspaceRepositoryUrl: string
  existingKnowledge: ExistingKnowledgeFile[]
  knownKnowledgePaths: Readonly<Record<string, string>>
  stampImportKey: boolean
}) {
  const batch = input.extraction
  const existingPaths = new Set(
    input.existingKnowledge.map((file) => file.path),
  )
  const referencePaths = new Map(
    Object.entries(input.knownKnowledgePaths).filter(([, path]) =>
      existingPaths.has(path),
    ),
  )
  for (const file of input.existingKnowledge)
    referencePaths.set(
      servingIdForKnowledgePath(input.workspaceId, file.path),
      file.path,
    )
  const repositoryUrl = normalizeWorkspaceRepositoryUrl(batch.repositoryUrl)
  if (
    repositoryUrl ===
    normalizeWorkspaceRepositoryUrl(input.workspaceRepositoryUrl)
  ) {
    if (existingPaths.has("AGENTS.md"))
      referencePaths.set(batch.repositoryId, "AGENTS.md")
  } else {
    const declaration = input.existingKnowledge.find((file) => {
      if (!isLinkedRepositoryDeclaration(file.path)) return false
      const parsed = parseLinkedRepositoryMarkdown(file.content)
      return (
        !parsed.malformed &&
        normalizeWorkspaceRepositoryUrl(parsed.git) === repositoryUrl
      )
    })
    if (declaration) referencePaths.set(batch.repositoryId, declaration.path)
  }
  return planKnowledgeProjection({
    workspaceId: input.workspaceId,
    firstWorkspaceId: input.workspaceId,
    workspaceRepositoryUrl: input.workspaceRepositoryUrl,
    workspaceByRepositoryId: new Map([[batch.repositoryId, input.workspaceId]]),
    repositoryGitUrlById: new Map([[batch.repositoryId, batch.repositoryUrl]]),
    knownKnowledgePaths: input.knownKnowledgePaths,
    stampImportKey: input.stampImportKey,
    referencePaths,
    objects: batch.objects.map((object) => ({
      id: object.deduplicationKey,
      kind: object.kind,
      deduplicationKey: object.deduplicationKey,
      payload: object.payload,
    })),
    claims: batch.claims.map((claim) => ({
      subjectId: claim.subjectRef,
      objectId: claim.objectRef,
      predicate: claim.predicate,
      aggregatedConfidence: claim.confidence,
      evidenceKey: claim.sourceId,
      validFrom: null,
      validTo: null,
    })),
    linkedUrls: [],
    existingKnowledge: input.existingKnowledge,
  })
}
