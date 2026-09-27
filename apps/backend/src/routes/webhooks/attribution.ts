import { applyAttribution } from "../../observability/attribution.js"

/**
 * One webhook can match several connections. Org and connection are set on
 * the request span only when every row shares them. Each enqueued job carries
 * its own. Actor type is set once by the webhook middleware.
 */
export function noteResolvedWebhookConnections(
  rows: { orgId: string; id: string }[],
): void {
  const orgIds = [...new Set(rows.map((row) => row.orgId).filter(Boolean))]
  const [orgId] = orgIds
  if (orgIds.length !== 1 || !orgId) return
  const connectionIds = [...new Set(rows.map((row) => row.id).filter(Boolean))]
  const connectionId = connectionIds.length === 1 ? connectionIds[0] : undefined
  applyAttribution({
    "ctxpipe.org.id": orgId,
    ...(connectionId ? { "ctxpipe.connection.id": connectionId } : {}),
  })
}
