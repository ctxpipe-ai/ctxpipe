import type { WorkspaceExtraction } from "./extraction.js"
import { servingIdForKnowledgePath } from "./hydrate.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
} from "./layout.js"
import {
  checkoutableGitUrl,
  type ExistingKnowledgeFile,
  planKnowledgeProjection,
} from "./migration-export.js"
import { retractExtractionClaims } from "./retract-extraction.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Convert captured extractor references to paths already owned by the Git tree. */
export async function planCapturedExtraction(input: {
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
  const plan = await planKnowledgeProjection({
    workspaceId: input.workspaceId,
    firstWorkspaceId: input.workspaceId,
    workspaceRepositoryUrl: input.workspaceRepositoryUrl,
    workspaceByRepositoryId: new Map([[batch.repositoryId, input.workspaceId]]),
    repositoryGitUrlById: new Map([[batch.repositoryId, batch.repositoryUrl]]),
    knownKnowledgePaths: input.knownKnowledgePaths,
    stampImportKey: input.stampImportKey,
    referencePaths,
    claimIdentity: (_fromPath, claim) =>
      JSON.stringify([claim.to, claim.predicate, claim.source ?? null]),
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
      source: `${checkoutableGitUrl(batch.repositoryUrl)}${claim.sourcePath ? `#${claim.sourcePath.split("/").map(encodeURIComponent).join("/")}` : ""}`,
      validFrom: null,
      validTo: null,
    })),
    linkedUrls: [],
    existingKnowledge: input.existingKnowledge,
  })
  const files = new Map(
    input.existingKnowledge.map((file) => [file.path, file]),
  )
  for (const file of plan.files) files.set(file.path, file)
  return {
    ...plan,
    files: retractExtractionClaims({
      extraction: batch,
      workspaceRepositoryUrl: input.workspaceRepositoryUrl,
      files: [...files.values()],
      referencePaths: new Map([
        ...referencePaths,
        ...Object.entries(plan.knowledgePaths),
      ]),
    }),
  }
}
