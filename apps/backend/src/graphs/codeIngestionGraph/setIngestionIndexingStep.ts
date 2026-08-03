import { tryGetOrgDb, withOrgDbContext } from "../../db/client.js"
import { getLogger } from "../../observability/logger.js"
import type { IndexingStepKey } from "../../domain/indexingSteps.js"
import { setRepositoryIndexingStep } from "../../models/repositories.js"

/**
 * Best-effort step tracker for code-ingestion graph nodes.
 *
 * Reuses the current org DB transaction when already inside
 * `withOrgDbContext` (avoids a second pool checkout during parallel
 * `identify_*` fan-out). Otherwise opens a short dedicated transaction.
 * Errors are swallowed — step tracking must never block ingestion progress.
 *
 * Parallel `identify_*` nodes may call this concurrently; the `monotonic` flag
 * in `setRepositoryIndexingStep` prevents any node from regressing the counter.
 */
export async function setIngestionIndexingStep(
  state: { repositoryId: string; orgId: string },
  key: IndexingStepKey,
): Promise<void> {
  try {
    const write = () =>
      setRepositoryIndexingStep({
        repositoryId: state.repositoryId,
        key,
        monotonic: true,
      })

    if (tryGetOrgDb()) {
      await write()
    } else {
      await withOrgDbContext(state.orgId, write)
    }
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
