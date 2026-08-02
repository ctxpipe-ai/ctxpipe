import { withOrgDbContext } from "../../db/client.js"
import { getLogger } from "../../observability/logger.js"
import type { IndexingStepKey } from "../../domain/indexingSteps.js"
import { setRepositoryIndexingStep } from "../../models/repositories.js"

/**
 * Best-effort step tracker for code-ingestion graph nodes.
 *
 * Wraps `setRepositoryIndexingStep` (monotonic) in its own `withOrgDbContext`
 * transaction so it is independent of any surrounding node transaction. Errors
 * are swallowed — step tracking must never block ingestion progress.
 *
 * Parallel `identify_*` nodes may call this concurrently; the `monotonic` flag
 * in `setRepositoryIndexingStep` prevents any node from regressing the counter.
 */
export async function setIngestionIndexingStep(
  state: { repositoryId: string; orgId: string },
  key: IndexingStepKey,
): Promise<void> {
  try {
    await withOrgDbContext(state.orgId, () =>
      setRepositoryIndexingStep({
        repositoryId: state.repositoryId,
        key,
        monotonic: true,
      }),
    )
  } catch (err) {
    getLogger().warn(
      "setIngestionIndexingStep: failed to update step (non-fatal)",
      {
        repositoryId: state.repositoryId,
        key,
        error: err instanceof Error ? err.message : String(err),
      },
    )
  }
}
