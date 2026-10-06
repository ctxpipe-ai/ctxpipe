import { randomUUID } from "node:crypto"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import type {
  CapturedExtraction,
  WorkspaceExtraction,
} from "../domain/workspaces/extraction.js"
import { EXTRACTOR_VERSION } from "../graphs/codeIngestionGraph/runExtractRoot.js"
import { ExtractedObjectSchema } from "../graphs/codeIngestionGraph/schemas.js"
import { storeRootCapture } from "../models/repository-extraction-captures.js"

/**
 * Store a test capture as the single root `.` and return the queued command
 * that refers to it. A placeholder repository row satisfies the foreign key
 * when the test uses a made-up repository id.
 */
export async function storeTestExtraction(
  orgId: string,
  { objects, claims, ...header }: CapturedExtraction,
): Promise<WorkspaceExtraction> {
  await withOrgDbContext(orgId, (db) =>
    db
      .insert(repositories)
      .values({
        id: header.repositoryId,
        orgId,
        name: header.repositoryId,
        gitUrl: `https://fixture.invalid/${header.repositoryId}`,
      })
      .onConflictDoNothing(),
  )
  const scope = `test:${randomUUID()}`
  // The stored form of the publishable fields: the loader parses it as extractor output.
  const kindOf = (ref: string) =>
    objects.find((object) => object.deduplicationKey === ref)?.kind ??
    "Repository"
  await storeRootCapture(
    {
      orgId,
      repositoryId: header.repositoryId,
      sourceSha: header.sourceSha,
      scope,
      extractorVersion: EXTRACTOR_VERSION,
    },
    ".",
    {
      extractedObjects: objects.map((object) => ({
        ...object,
        kind: ExtractedObjectSchema.shape.kind.parse(object.kind),
      })),
      extractedClaims: claims.map(({ sourcePath, ...claim }) => ({
        ...claim,
        subjectKind: kindOf(claim.subjectRef),
        objectKind: kindOf(claim.objectRef),
        sourceType: "git",
        extractionMethod: "llm",
        ...(sourcePath ? { provenance: { path: sourcePath } } : {}),
      })),
    },
    0,
  )
  return {
    ...header,
    capture: { scope, extractorVersion: EXTRACTOR_VERSION, roots: ["."] },
  }
}
