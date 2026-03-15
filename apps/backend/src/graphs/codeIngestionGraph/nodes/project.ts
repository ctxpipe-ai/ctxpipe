import { projectClaimsFromState } from "../../../retrieval/services/graphProjection.js"
import type { CodeIngestionState } from "../schemas.js"

/**
 * Projects claims from state to FalkorDB. Uses requireCurrentOrgId/requireCurrentOrgSlug.
 */
export async function project(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const claimsForProjection = state.claimsForProjection ?? []
  if (claimsForProjection.length === 0) return {}
  await projectClaimsFromState(claimsForProjection)
  return {}
}
