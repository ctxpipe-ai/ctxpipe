import { withOrgDbContext } from "../../../db/client.js"
import { getLogger } from "../../../observability/logger.js"
import { projectClaimsFromState } from "../../../retrieval/services/graphProjection.js"
import type { CodeIngestionState } from "../schemas.js"

/**
 * Projects claims from state to FalkorDB. Uses requireCurrentOrgId/requireCurrentOrgSlug.
 */
export async function project(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const logger = getLogger()
  const claimsForProjection = state.claimsForProjection ?? []
  logger.set({
    step: "codeIngestion.project",
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    roots: state.roots,
    claimsForProjectionCount: claimsForProjection.length,
  })
  logger.info("projecting claims to graph")

  if (claimsForProjection.length === 0) {
    logger.set({
      step: "codeIngestion.project.skipped",
      reason: "no claims to project",
    })
    logger.info("project skipped (no claims)")
    return {}
  }

  await withOrgDbContext(state.orgId, () =>
    projectClaimsFromState(claimsForProjection),
  )
  return {}
}
