import { applyAttribution } from "./attribution.js"
import { tryGetLogger } from "./requestLogger.js"

/** Org and connection are known even when the handler does not enqueue a job. */
export function noteResolvedWebhookConnection(input: {
  orgId: string
  connectionId: string
}): void {
  noteResolvedWebhookConnections([input])
}

/**
 * One webhook can match several connections. A single request span cannot
 * name every org, so org and connection are set only when they are unique.
 * Each enqueued job carries its own org and connection.
 */
export function noteResolvedWebhookConnections(
  connections: { orgId: string; connectionId: string }[],
): void {
  const orgIds = [
    ...new Set(
      connections.map((connection) => connection.orgId).filter(Boolean),
    ),
  ]
  if (orgIds.length !== 1) return
  const connectionIds = [
    ...new Set(
      connections.map((connection) => connection.connectionId).filter(Boolean),
    ),
  ]
  const orgId = orgIds[0]
  const connectionId = connectionIds.length === 1 ? connectionIds[0] : undefined
  if (!orgId) return
  applyAttribution(
    {
      "ctxpipe.actor.type": "webhook",
      "ctxpipe.org.id": orgId,
      ...(connectionId ? { "ctxpipe.connection.id": connectionId } : {}),
    },
    tryGetLogger(),
  )
}
