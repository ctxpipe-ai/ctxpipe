import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/organizations.js"
import { markRepositoryIndexingPending } from "../models/repositories.js"
import { ow } from "./client.js"
import { repositoryIngestion } from "./repository-ingestion.js"

/** Set up org id + db context so model calls can use requireCurrentOrgId / getOrgDb. */
async function withOrgContext<T>(
  orgId: string,
  handler: () => Promise<T>,
): Promise<T> {
  const [org] = await getSystemDb()
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  if (!org) throw new Error(`Organization not found: ${orgId}`)
  return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
    withOrgDbContext(org.id, () => handler()),
  )
}

export type RepositoryIngestionEnqueueInput = {
  repositoryId: string
  orgId: string
  /** Shown in the repositories UI while ingestion runs; cleared on success. */
  indexingReason?: string | null
}

/**
 * Marks the repo as mid-ingestion for the UI, then enqueues repository-ingestion.
 * Awaits the DB update so callers can return HTTP 200 after the UI can poll `indexReady`.
 * Workflow failures are logged; the row stays pending until a retry succeeds.
 */
export async function enqueueRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  // Enqueue is the network-level entry for webhooks (no request context), so
  // we establish org id + DB context here before calling the model.
  await withOrgContext(input.orgId, () =>
    markRepositoryIndexingPending({
      repositoryId: input.repositoryId,
      reason: input.indexingReason ?? null,
    }),
  )

  void ow
    .runWorkflow(repositoryIngestion.spec, {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      ...(input.indexingReason !== undefined
        ? { indexingReason: input.indexingReason }
        : {}),
    })
    .catch((err: unknown) => {
      log.error(err instanceof Error ? err : new Error(String(err)))
    })
}

/** Await ingestion workflow (e.g. parent sync workflow). */
export async function runRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  await withOrgContext(input.orgId, () =>
    markRepositoryIndexingPending({
      repositoryId: input.repositoryId,
      reason: input.indexingReason ?? null,
    }),
  )

  try {
    await ow.runWorkflow(repositoryIngestion.spec, {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      ...(input.indexingReason !== undefined
        ? { indexingReason: input.indexingReason }
        : {}),
    })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}
