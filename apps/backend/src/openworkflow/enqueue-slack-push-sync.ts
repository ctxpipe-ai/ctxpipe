import { withOrgDbContext } from "../db/client.js"
import { markSlackSyncTargetInitialSync } from "../models/slack-connector.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { slackSyncContent } from "./workflows/slack-sync-content.js"

type GithubWebhookLog = { error: (e: Error) => void }

export async function enqueueSlackFullSyncAfterConfigPush(input: {
  orgId: string
  connectionId: string
  log: GithubWebhookLog
}): Promise<void> {
  await withOrgDbContext(input.orgId, () =>
    markSlackSyncTargetInitialSync({ connectionId: input.connectionId }),
  )

  try {
    await runWorkflowWithWorkerWake(slackSyncContent.spec, {
      orgId: input.orgId,
      connectionId: input.connectionId,
    })
  } catch (err) {
    input.log.error(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}
