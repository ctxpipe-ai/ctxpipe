import { createHash, timingSafeEqual } from "node:crypto"
import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../../app/env.js"
import { enqueueConnectionSourcesSync } from "../../../domain/workspace-sources/enqueue.js"
import { getPlainWebhookTarget } from "../../../models/plain-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { PLAIN_WEBHOOK_TOKEN_HEADER } from "../../../services/plain/client.js"
import type { PlainThreadEvent } from "../../../services/plain/workspace-source-adapter.js"
import { noteResolvedWebhookConnections } from "../attribution.js"

/**
 * Thread events sync the connection at most once in this window: many
 * messages give one commit for each Workspace in each window.
 */
const SYNC_WINDOW_MS = 10 * 60 * 1000

/** Compare two tokens in constant time, also when their lengths differ. */
function sameToken(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

/**
 * ctx| creates one Plain webhook target for each connection, so the URL
 * names the connection and the route checks that connection's token
 * (ADR-056). The target sends only timeline events, so each delivery is
 * thread activity; the body is not read.
 */
async function handlePlainWebhook(c: Context<AppEnv>) {
  const connectionId = c.req.param("connectionId") ?? ""
  const target = await getPlainWebhookTarget(connectionId, c.var.env)
  const token = c.req.header(PLAIN_WEBHOOK_TOKEN_HEADER)
  if (!target?.webhookToken || !token || !sameToken(token, target.webhookToken))
    return c.json({ error: "Unauthorized" }, 401)
  noteResolvedWebhookConnections([{ orgId: target.orgId, id: connectionId }])
  if (target.status !== "installed") return c.body(null, 200)

  // ADR-050: one sources sync of the connection at the end of the window. A
  // later event in the same window has the same key and queues nothing. A
  // failed enqueue returns 5xx, so Plain sends the event again.
  const windowStart = Math.floor(Date.now() / SYNC_WINDOW_MS) * SYNC_WINDOW_MS
  try {
    await enqueueConnectionSourcesSync({
      orgId: target.orgId,
      connectionId,
      provider: "plain",
      event: { kind: "threads" } satisfies PlainThreadEvent,
      dedupeKey: `threads:${windowStart}`,
      availableAt: new Date(windowStart + SYNC_WINDOW_MS),
    })
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "plain_webhook.sources", connectionId },
    )
    return c.json({ error: "Failed to enqueue Plain sync" }, 503)
  }
  return c.body(null, 200)
}

export function registerPlainWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/plain/:connectionId", (c) => handlePlainWebhook(c))
}
