import { eq } from "drizzle-orm"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import { withOrgDbContext } from "../../../db/client.js"
import { repositories } from "../../../db/schema/repositories.js"
import { createClaim } from "../../../retrieval/services/claimWrite.js"
import { upsertRetrievalObject } from "../../../retrieval/services/retrievalObjectWrite.js"

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".json",
  ".yaml",
  ".yml",
  ".md",
])

function isCodeFile(path: string): boolean {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : ""
  return CODE_EXTENSIONS.has(ext.toLowerCase())
}

export type ExtractState = {
  repositoryId: string
  orgId: string
  targetHash: string
  indexedAt?: string
}

export type ExtractResult = {
  objectIds: string[]
  claimIds: string[]
}

/**
 * Extracts claims and retrieval objects from indexed repository.
 * Lists code files, fetches contents, creates retrieval objects and claims.
 */
export async function extract(state: ExtractState): Promise<ExtractResult> {
  const { repositoryId, orgId, targetHash } = state

  const repoRows = await withOrgDbContext(orgId, async (db) =>
    db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1),
  )
  const repo = repoRows[0]
  if (!repo) {
    throw new Error(`Repository not found: ${repositoryId}`)
  }

  const paths = await listFilesRecursive(repositoryId, orgId)
  const codePaths = paths.filter(isCodeFile)

  const BATCH_SIZE = 50
  const objectIds: string[] = []
  const claimIds: string[] = []

  for (let i = 0; i < codePaths.length; i += BATCH_SIZE) {
    const batch = codePaths.slice(i, i + BATCH_SIZE)
    const contents = await fetchFiles(repositoryId, orgId, batch)

    for (const path of batch) {
      const content = contents[path] ?? ""
      const objId = await upsertRetrievalObject(orgId, {
        type: "code_chunk",
        payload: {
          repositoryId,
          repositoryName: repo.name,
          path,
          content,
          targetHash,
        },
      })
      objectIds.push(objId)

      const claimId = await createClaim(
        orgId,
        {
          subjectId: repositoryId,
          predicate: "contains",
          objectId: objId,
        },
        {
          sourceType: "git",
          sourceId: `${repositoryId}:${path}:${targetHash}`,
          extractionMethod: "deterministic",
          confidence: 0.9,
          provenance: { path, targetHash },
        },
      )
      claimIds.push(claimId)
    }
  }

  return { objectIds, claimIds }
}
