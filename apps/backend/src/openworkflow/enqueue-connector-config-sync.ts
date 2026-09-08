import {
  activateConnectorSync,
  findConnectorSyncOwner,
  prepareConnectorSync,
} from "../models/connector-content-sync.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { connectorConfigKey } from "./enqueue-connector-content-sync.js"
import {
  type ConfluenceConfigSyncInput,
  confluenceSyncConfig,
} from "./workflows/confluence-sync-config.js"
import {
  type LinearConfigSyncInput,
  linearSyncConfig,
} from "./workflows/linear-sync-config.js"
import {
  type NotionConfigSyncInput,
  notionSyncConfig,
} from "./workflows/notion-sync-config.js"

type ConfigProposal = {
  orgId: string
  orgSlug: string
  connectionId: string
  repositoryId?: string
  branch?: string
} & (
  | { provider: "linear"; scopes: LinearConfigSyncInput["scopes"] }
  | { provider: "notion"; resources: NotionConfigSyncInput["resources"] }
  | {
      provider: "confluence"
      spaces: NonNullable<ConfluenceConfigSyncInput["spaces"]>
    }
)

/** Persist proposal intent in its native owner before publishing setup state. */
export async function enqueueConnectorConfigSync(
  input: ConfigProposal,
): Promise<{
  accepted: boolean
  started: boolean
}> {
  const selection =
    input.provider === "linear"
      ? input.scopes
      : input.provider === "notion"
        ? input.resources
        : input.spaces
  const configKey = `proposal:${connectorConfigKey(selection)}`
  const intent = await prepareConnectorSync({
    ...input,
    purpose: "config",
    configKey,
  })
  if (!intent) return { accepted: false, started: false }
  if (intent.existingRunId) return { accepted: true, started: false }
  const idempotencyKey = `connector-config:${input.connectionId}:${intent.contentSyncGeneration}:${configKey}`
  const common = {
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    connectionId: input.connectionId,
    contentSyncGeneration: intent.contentSyncGeneration,
    contentSyncBinding: intent.contentSyncBinding,
    configKey,
  }
  let workflowRunId: string
  try {
    const handle =
      input.provider === "linear"
        ? await runWorkflowWithWorkerWake(
            linearSyncConfig.spec,
            { ...common, scopes: input.scopes },
            { idempotencyKey },
          )
        : input.provider === "notion"
          ? await runWorkflowWithWorkerWake(
              notionSyncConfig.spec,
              { ...common, resources: input.resources },
              { idempotencyKey },
            )
          : await runWorkflowWithWorkerWake(
              confluenceSyncConfig.spec,
              { ...common, spaces: input.spaces },
              { idempotencyKey },
            )
    workflowRunId = handle.workflowRun.id
  } catch (error) {
    const owner = await findConnectorSyncOwner({
      ...input,
      purpose: "config",
      idempotencyKey,
    })
    if (!owner) throw error
    workflowRunId = owner
  }
  const accepted = await activateConnectorSync({
    purpose: "config",
    orgId: input.orgId,
    connectionId: input.connectionId,
    workflowRunId,
  })
  return { accepted, started: accepted }
}
