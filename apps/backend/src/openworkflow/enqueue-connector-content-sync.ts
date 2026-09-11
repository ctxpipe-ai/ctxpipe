import { createHash } from "node:crypto"
import {
  activateConnectorSync,
  findConnectorSyncOwner,
  prepareConnectorSync,
} from "../models/connector-content-sync.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { confluenceSyncContent } from "./workflows/confluence-sync-content.js"
import { linearSyncContent } from "./workflows/linear-sync-content.js"
import { notionSyncContent } from "./workflows/notion-sync-content.js"

/** Keys describe config intent; Git's captured config blob remains the content fence. */
export function connectorConfigKey(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex")
}

export async function enqueueConnectorContentSync(
  input: {
    orgId: string
    orgSlug?: string
    connectionId: string
    provider: "linear" | "notion" | "confluence"
    repositoryId?: string
    configKey?: string
  } & (
    | { legacyConfigRecovery: true; branch?: string }
    | { legacyConfigRecovery?: false; branch: string }
  ),
): Promise<boolean> {
  const intent = await prepareConnectorSync({ ...input, purpose: "content" })
  if (!intent) return false
  if (intent.existingRunId) return true
  const idempotencyKey = `connector-content:${input.connectionId}:${intent.contentSyncGeneration}:${input.configKey ?? "retry"}`
  const workflowInput = {
    orgId: input.orgId,
    connectionId: input.connectionId,
    contentSyncGeneration: intent.contentSyncGeneration,
    contentSyncBinding: intent.contentSyncBinding,
    configKey: input.configKey,
  }
  let workflowRunId: string
  try {
    if (input.provider === "linear") {
      const handle = await runWorkflowWithWorkerWake(
        linearSyncContent.spec,
        workflowInput,
        { idempotencyKey },
      )
      workflowRunId = handle.workflowRun.id
    } else {
      if (!input.orgSlug)
        throw new Error("Organization slug missing for content sync")
      const handle =
        input.provider === "notion"
          ? await runWorkflowWithWorkerWake(
              notionSyncContent.spec,
              { ...workflowInput, orgSlug: input.orgSlug },
              { idempotencyKey },
            )
          : await runWorkflowWithWorkerWake(
              confluenceSyncContent.spec,
              { ...workflowInput, orgSlug: input.orgSlug },
              { idempotencyKey },
            )
      workflowRunId = handle.workflowRun.id
    }
  } catch (error) {
    const owner = await findConnectorSyncOwner({
      purpose: "content",
      ...input,
      idempotencyKey,
    })
    if (!owner) throw error
    workflowRunId = owner
  }
  return activateConnectorSync({
    purpose: "content",
    orgId: input.orgId,
    connectionId: input.connectionId,
    workflowRunId,
  })
}
