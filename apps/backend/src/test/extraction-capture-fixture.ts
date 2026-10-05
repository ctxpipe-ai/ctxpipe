import { randomUUID } from "node:crypto"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import type {
  CapturedExtraction,
  WorkspaceExtraction,
} from "../domain/workspaces/extraction.js"
import { EXTRACTOR_VERSION } from "../graphs/codeIngestionGraph/runExtractRoot.js"
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
  await storeRootCapture(
    {
      orgId,
      repositoryId: header.repositoryId,
      sourceSha: header.sourceSha,
      scope,
      extractorVersion: EXTRACTOR_VERSION,
    },
    ".",
    // Test captures hold the publishable fields only; the loader reads no others.
    {
      extractedObjects: objects,
      extractedClaims: claims.map(({ sourcePath, ...claim }) => ({
        ...claim,
        ...(sourcePath ? { provenance: { path: sourcePath } } : {}),
      })),
    } as Parameters<typeof storeRootCapture>[2],
  )
  return {
    ...header,
    capture: { scope, extractorVersion: EXTRACTOR_VERSION, roots: ["."] },
  }
}
