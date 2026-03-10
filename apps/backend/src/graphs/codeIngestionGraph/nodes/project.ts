import { projectClaimsToGraph } from "../../../retrieval/services/graphProjection.js"
import type { CodeIngestionState } from "../schemas.js"

/**
 * Projects claims to FalkorDB. Uses requireCurrentOrgId/requireCurrentOrgSlug.
 */
export async function project(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { claimIds = [] } = state
  if (claimIds.length === 0) return {}

  await projectClaimsToGraph({ claimIds })
  return {}
}
