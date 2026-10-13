import { connectionHasWorkspaceSources } from "../models/workspace-sources.js"
import {
  type ConnectorRepositoryIngestionInput,
  enqueueRepositoryIngestionWorkflow,
} from "./enqueue-repository-ingestion.js"

/**
 * Start ingestion on the legacy sync repository of a connector connection.
 * A connection that has Workspace sources syncs through its Workspace, so
 * this starts no run for it.
 */
export async function enqueueLegacySyncRepositoryIngestion(
  input: ConnectorRepositoryIngestionInput & { connectionId: string },
  log: { error: (err: Error) => void },
): Promise<void> {
  const { connectionId, ...ingestion } = input
  if (
    await connectionHasWorkspaceSources({ orgId: input.orgId, connectionId })
  ) {
    return
  }
  await enqueueRepositoryIngestionWorkflow(ingestion, log)
}
