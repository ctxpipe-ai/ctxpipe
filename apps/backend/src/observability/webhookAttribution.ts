import { applyAttribution } from "./attribution.js"
import { tryGetLogger } from "./requestLogger.js"

/** Org and connection are known even when the handler does not enqueue a job. */
export function noteResolvedWebhookConnection(input: {
  orgId: string
  connectionId: string
}): void {
  if (!input.orgId || !input.connectionId) return
  applyAttribution(
    {
      "ctxpipe.actor.type": "webhook",
      "ctxpipe.org.id": input.orgId,
      "ctxpipe.connection.id": input.connectionId,
    },
    tryGetLogger(),
  )
}
